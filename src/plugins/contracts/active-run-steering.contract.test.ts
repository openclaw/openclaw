import assert from "node:assert/strict";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueMessageOptions } from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
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
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { PluginActiveRunSteerParams } from "../plugin-api.types.js";
import { getPluginInstance } from "../plugin-instance-scope.js";
import { createPluginRegistry } from "../registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../runtime.js";
import { createPluginRuntime } from "../runtime/index.js";
import { createPluginRecord } from "../status.test-helpers.js";

const sessionKey = "agent:main:steering-test";
const sessionId = "steering-session";
const steered = { steered: true, runId: "steered-run" };

function createApi(allowPromptInjection = true, config: OpenClawConfig = {}) {
  const runtime = createPluginRuntime();
  runtime.config.current = () => config;
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
  });
  const record = createPluginRecord({
    id: "steering-plugin",
    name: "Steering Plugin",
    origin: "bundled",
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, hookPolicy: { allowPromptInjection } });
  setActivePluginRegistry(builder.registry);
  return {
    record,
    steer: (input: Partial<PluginActiveRunSteerParams> = {}) =>
      api.session.workflow.steerActiveRun({ sessionKey, text: "Guidance", ...input }),
  };
}

function createQueue(
  before?: (text: string, options?: EmbeddedAgentQueueMessageOptions) => Promise<void>,
) {
  const modelInput: string[] = [];
  const queueMessage = vi.fn(async (text: string, options?: EmbeddedAgentQueueMessageOptions) => {
    if (before) {
      await before(text, options);
    }
    modelInput.push(text);
  });
  return { modelInput, queueMessage };
}

function startRun(
  queueMessage: (text: string, options?: EmbeddedAgentQueueMessageOptions) => Promise<void>,
  available = true,
  runId = "steered-run",
  storeScope?: string,
  runSessionKey = sessionKey,
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
    runSessionKey,
    undefined,
    "main",
    undefined,
    undefined,
    { storeScope },
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
      const { steer } = createApi(true, { session: { store: target.storePath } });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const { modelInput, queueMessage } = createQueue(async (_text, options) => {
        entered.resolve();
        await release.promise;
        if (delivery !== "successor-run") {
          await options?.userTurnTranscriptRecorder?.confirmSteerTargetRunIdForPersistence?.(
            "steered-run",
          );
        }
        const persisted = await options?.userTurnTranscriptRecorder?.persistApproved();
        assert(persisted);
      });
      startRun(queueMessage, true, "steered-run", target.storePath);
      const input = {
        sessionKey,
        text: "Use the corrected result.",
        idempotencyKey: "same-review",
      };
      const first = steer(input);
      await entered.promise;
      const second = delivery === "concurrent" ? steer(input) : undefined;
      release.resolve();
      expect(await first).toEqual(steered);
      if (delivery === "successor-run" || delivery === "successor-run-receipt") {
        startRun(queueMessage, true, "successor-run", target.storePath);
      }
      expect(await (second ?? steer(input))).toEqual(
        delivery === "successor-run" ? { steered: false, reason: "duplicate" } : steered,
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

  it.each(["incognito", "retry"] as const)("queues guidance for an %s run", async (mode) => {
    const incognito = mode === "incognito";
    const key = incognito ? "agent:main:dashboard:incognito-steering-test" : sessionKey;
    const runId = incognito ? "incognito-steered-run" : "steered-run";
    const { steer } = createApi();
    const { modelInput, queueMessage } = createQueue(async () => {
      if (!incognito && queueMessage.mock.calls.length === 1) {
        throw new Error("backend refused");
      }
    });
    startRun(
      queueMessage,
      true,
      runId,
      incognito ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }) : undefined,
      key,
    );
    const input = {
      sessionKey: key,
      text: "Check the current result.",
      ...(!incognito ? { idempotencyKey: "retry-review" } : {}),
    };
    if (!incognito) {
      await expect(steer(input)).resolves.toEqual({ steered: false, reason: "runtime_rejected" });
    }
    await expect(steer(input)).resolves.toEqual({ steered: true, runId });
    expect(modelInput).toEqual([input.text]);
    expect(queueMessage).toHaveBeenCalledTimes(incognito ? 1 : 2);
  });

  it("delivers hidden internal guidance without sender authority or answering a pending question", async () => {
    const { steer } = createApi();
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
        __openclaw: {
          senderIsOwner: false,
          pluginSteering: {
            pluginId: "steering-plugin",
            pluginName: "Steering Plugin",
            displayText: "Check the result.",
          },
        },
      });
      expect(message).not.toHaveProperty(["__openclaw", "senderId"]);
      expect(message).not.toHaveProperty(["__openclaw", "senderIdentity"]);
    });
    const claimAnswer = startRun(queueMessage);
    await expect(
      steer({
        text: "Check the current result.",
        displayText: "Check the result.",
        idempotencyKey: "review-1",
      }),
    ).resolves.toEqual(steered);
    expect(queueMessage).toHaveBeenCalledOnce();
    expect(claimAnswer).not.toHaveBeenCalled();
  });

  it.each(["legacy", "disabled", "no_active_run", "not_streaming", "runtime_rejected"] as const)(
    "returns a reason instead of throwing for %s",
    async (reason) => {
      const { steer } = createApi(reason !== "disabled");
      const queueMessage = vi.fn(async () => {
        throw new Error("backend refused");
      });
      if (reason === "legacy") {
        setActiveEmbeddedRun(
          sessionId,
          {
            ...createEmbeddedRunHandle({ runId: "legacy-run" }),
            messageInjection: { isAvailable: () => true, queueMessage },
          },
          sessionKey,
        );
      } else if (reason !== "no_active_run") {
        startRun(queueMessage, reason !== "not_streaming");
      }
      const reasons = {
        legacy: "active runtime does not support guarded steering",
        disabled: "blocked by plugins.entries.steering-plugin.hooks.allowPromptInjection=false",
      };
      await expect(steer()).resolves.toEqual({
        steered: false,
        reason: reason === "legacy" || reason === "disabled" ? reasons[reason] : reason,
      });
      if (reason === "legacy" || reason === "disabled") {
        expect(queueMessage).not.toHaveBeenCalled();
      }
    },
  );

  it("rechecks the plugin lifetime after loading the dispatch module", async () => {
    const { steer, record } = createApi();
    const queueMessage = vi.fn(async () => {});
    startRun(queueMessage);
    const pending = steer();
    const rejected = expect(pending).rejects.toThrow(/no longer loaded|reloaded or disabled/);
    await getPluginInstance(record)?.dispose();
    await rejected;
    expect(queueMessage).not.toHaveBeenCalled();
  });
});
