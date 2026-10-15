import assert from "node:assert/strict";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueMessageOptions,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetDiagnosticRunActivityForTest } from "../../logging/diagnostic-run-activity.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import {
  createSqliteTranscriptTarget,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { getPluginInstance } from "../plugin-instance-scope.js";
import { createPluginRegistry } from "../registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../runtime.js";
import { createPluginRuntime } from "../runtime/index.js";
import { createPluginRecord } from "../status.test-helpers.js";

const sessionKey = "agent:main:steering-test";
const sessionId = "steering-session";

function createApi(allowPromptInjection = true, config: OpenClawConfig = {}) {
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
  });
  const record = createPluginRecord({ id: "steering-plugin", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, hookPolicy: { allowPromptInjection } });
  setActivePluginRegistry(builder.registry);
  return { api, record };
}

function startRun(
  queueMessage: (text: string, options?: EmbeddedAgentQueueMessageOptions) => Promise<void>,
  available = true,
  runId = "steered-run",
) {
  const claimPendingUserInputAnswer = vi.fn(async () => true);
  setActiveEmbeddedRun(
    sessionId,
    {
      ...createEmbeddedRunHandle({ runId }),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => available,
        queueMessage,
        claimPendingUserInputAnswer,
      },
    },
    sessionKey,
  );
  return claimPendingUserInputAnswer;
}

afterEach(() => {
  testing.resetActiveEmbeddedRuns();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticSessionStateForTest();
  resetPluginRuntimeStateForTest();
});

describe("plugin active-run steering", () => {
  const sessionDirs = useSessionStoreTempDirs((cleanup) => afterAll(cleanup), "plugin-steering-");

  it.each(["sequential", "concurrent", "successor-run", "successor-run-receipt"] as const)(
    "admits an idempotency key to the transcript and model input once: %s",
    async (delivery) => {
      const target = createSqliteTranscriptTarget({
        dir: sessionDirs.make(),
        sessionId,
        sessionKey,
      });
      await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
      const { api } = createApi(true, { session: { store: target.storePath } });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const modelInput: string[] = [];
      const queueMessage = vi.fn(
        async (text: string, options?: EmbeddedAgentQueueMessageOptions) => {
          entered.resolve();
          await release.promise;
          if (delivery !== "successor-run") {
            await options?.userTurnTranscriptRecorder?.confirmSteerTargetRunIdForPersistence?.(
              "steered-run",
            );
          }
          const persisted = await options?.userTurnTranscriptRecorder?.persistApproved();
          assert(persisted);
          modelInput.push(text);
        },
      );
      startRun(queueMessage);
      const input = {
        sessionKey,
        text: "Use the corrected result.",
        idempotencyKey: "same-review",
      };
      const first = api.session.workflow.steerActiveRun(input);
      await entered.promise;
      const second =
        delivery === "concurrent" ? api.session.workflow.steerActiveRun(input) : undefined;
      release.resolve();
      expect(await first).toEqual({ steered: true, runId: "steered-run" });
      if (delivery === "successor-run" || delivery === "successor-run-receipt") {
        startRun(queueMessage, true, "successor-run");
      }
      expect(await (second ?? api.session.workflow.steerActiveRun(input))).toEqual(
        delivery === "successor-run"
          ? { steered: false, reason: "duplicate" }
          : { steered: true, runId: "steered-run" },
      );
      expect(await readTranscriptMessages(target)).toEqual([
        expect.objectContaining({
          content: input.text,
          idempotencyKey: input.idempotencyKey,
          ...(delivery !== "successor-run"
            ? { __openclaw: expect.objectContaining({ steerTargetRunId: "steered-run" }) }
            : {}),
        }),
      ]);
      expect(modelInput).toEqual([input.text]);
      expect(queueMessage).toHaveBeenCalledOnce();
    },
  );

  it("retries the same idempotency key after queue rejection", async () => {
    const { api } = createApi();
    const modelInput: string[] = [];
    const queueMessage = vi.fn(async (text: string) => {
      if (queueMessage.mock.calls.length === 1) {
        throw new Error("backend refused");
      }
      modelInput.push(text);
    });
    startRun(queueMessage);
    const input = { sessionKey, text: "Retry this guidance.", idempotencyKey: "retry-review" };
    await expect(api.session.workflow.steerActiveRun(input)).resolves.toEqual({
      steered: false,
      reason: "runtime_rejected",
    });
    await expect(api.session.workflow.steerActiveRun(input)).resolves.toEqual({
      steered: true,
      runId: "steered-run",
    });
    expect(modelInput).toEqual([input.text]);
    expect(queueMessage).toHaveBeenCalledTimes(2);
  });

  it("delivers hidden internal guidance without sender authority or answering a pending question", async () => {
    const { api } = createApi();
    const queueMessage = vi.fn(async (text: string, options?: EmbeddedAgentQueueMessageOptions) => {
      expect(text).toBe("Check the current result.");
      expect(options).toMatchObject({
        steeringMode: "all",
        debounceMs: 0,
        waitForTranscriptCommit: false,
        isInboundUserMessage: false,
        allowPendingUserInputAnswer: false,
      });
      expect(options).not.toHaveProperty("toolAuthorityOverlay");
      expect(options?.toolAuthorityFingerprint).toBeUndefined();
      expect(options).not.toHaveProperty("personalToolParticipant");
      const message = await options?.userTurnTranscriptRecorder?.resolveMessage();
      assert(message);
      expect(message).toMatchObject({
        role: "user",
        content: "Check the current result.",
        display: false,
        idempotencyKey: "review-1",
        provenance: { kind: "internal_system", sourceTool: "plugin:steering-plugin" },
        __openclaw: { senderIsOwner: false },
      });
      expect(message).not.toHaveProperty(["__openclaw", "senderId"]);
      expect(message).not.toHaveProperty(["__openclaw", "senderIdentity"]);
    });
    const claimAnswer = startRun(queueMessage);
    await expect(
      api.session.workflow.steerActiveRun({
        sessionKey,
        text: "Check the current result.",
        idempotencyKey: "review-1",
      }),
    ).resolves.toEqual({ steered: true, runId: "steered-run" });
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(claimAnswer).not.toHaveBeenCalled();
  });

  it("refuses an active V1 runtime before entering its transport queue", async () => {
    const { api } = createApi();
    const queueMessage = vi.fn(async () => {});
    setActiveEmbeddedRun(
      sessionId,
      {
        ...createEmbeddedRunHandle({ runId: "legacy-run" }),
        messageInjection: { isAvailable: () => true, queueMessage },
      },
      sessionKey,
    );
    await expect(
      api.session.workflow.steerActiveRun({ sessionKey, text: "Guidance" }),
    ).resolves.toEqual({
      steered: false,
      reason: "active runtime does not support guarded steering",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it.each(["no_active_run", "not_streaming", "runtime_rejected"] as const)(
    "returns a reason instead of throwing for %s",
    async (reason) => {
      const { api } = createApi();
      if (reason !== "no_active_run") {
        startRun(async () => {
          throw new Error("backend refused");
        }, reason !== "not_streaming");
      }
      await expect(
        api.session.workflow.steerActiveRun({ sessionKey, text: "Guidance" }),
      ).resolves.toEqual({ steered: false, reason });
    },
  );

  it("refuses steering when prompt injection is disabled", async () => {
    const { api } = createApi(false);
    const queueMessage = vi.fn(async () => {});
    startRun(queueMessage);
    await expect(
      api.session.workflow.steerActiveRun({ sessionKey, text: "Guidance" }),
    ).resolves.toEqual({
      steered: false,
      reason: "blocked by plugins.entries.steering-plugin.hooks.allowPromptInjection=false",
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("rechecks the plugin lifetime after loading the dispatch module", async () => {
    const { api, record } = createApi();
    const queueMessage = vi.fn(async () => {});
    startRun(queueMessage);
    const pending = api.session.workflow.steerActiveRun({ sessionKey, text: "Guidance" });
    const rejected = expect(pending).rejects.toThrow(/no longer loaded|reloaded or disabled/);
    await getPluginInstance(record)?.dispose();
    await rejected;
    expect(queueMessage).not.toHaveBeenCalled();
  });
});
