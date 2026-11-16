import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { createExecTool } from "../../agents/bash-tools.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../../agents/session-permission-exec-mode.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOrResumeClientVoiceSession,
  flushClientVoiceSessionWrites,
} from "../../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../../talk/client-voice-session.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import {
  createTalkClientAgentConsultRunner,
  prepareTalkClientControlAuthority,
} from "./client-agent-consult.js";
import { createControlFixture } from "./client-control-fixture.test-support.js";
import { retainTalkClientRunAuthority } from "./client-run-authority.js";
import { resolveTalkAgentConsultAuthority } from "./client-tool-authority.js";
import { readTalkRealtimeInitialItems } from "./session-history.js";
import { prepareTalkSessionTarget } from "./session-target.js";
import type { PreparedTalkSessionTarget } from "./session-target.types.js";

const model = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: replace inference while exercising real source guards and native effects.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: model.run }));
const freshness = vi.hoisted(() => ({
  beforeCheck: undefined as (() => Promise<void>) | undefined,
  afterStaleCheck: undefined as (() => void) | undefined,
}));
// mock-isolation: pause a voice consult between its reset-freshness check and the reset write.
vi.mock("../../config/sessions/entry-freshness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/entry-freshness.js")>();
  const read = actual.resolveSessionEntryResetFreshnessAsync;
  return {
    ...actual,
    resolveSessionEntryResetFreshnessAsync: async (...args: Parameters<typeof read>) => {
      await freshness.beforeCheck?.();
      return read(...args).finally(() => freshness.afterStaleCheck?.());
    },
  };
});

describe("authenticated Talk permission parity", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  const sessionKey = "agent:main:permission-parity";
  let sessionTarget: PreparedTalkSessionTarget;
  let voiceSessionId: string;
  const client = sharingPolicyClient({ deviceId: "parity-caller", scopes: ["operator.admin"] });

  function createRunner(
    overrides: Partial<Parameters<typeof createTalkClientAgentConsultRunner>[0]> = {},
  ) {
    return createTalkClientAgentConsultRunner({
      config,
      sessionTarget,
      context: {
        logGateway: createSubsystemLogger("test/talk-permission-parity"),
      },
      authority: resolveTalkAgentConsultAuthority(client.connect.scopes, client),
      getVoiceSessionId: () => voiceSessionId,
      initialItems: [],
      ...overrides,
    });
  }

  async function retainSource(isCurrent = () => true) {
    const context = {
      getRuntimeConfig: () => config,
      logGateway: { warn: vi.fn() },
    } as unknown as GatewayRequestContext;
    const source = captureGatewayDeviceRevocation(
      context,
      { deviceId: "parity-caller", role: "operator" },
      isCurrent,
      new AbortController().signal,
      { isCurrent: () => true, subscribe: () => () => {}, dependencies: { client, context } },
    );
    const retained = await retainTalkClientRunAuthority({
      client,
      context,
      hasCurrentClientAuthority: source.isCurrent,
    });
    return { context, source, retained };
  }

  function writeSession(fields: Omit<SessionEntry, "sessionId" | "updatedAt"> = {}) {
    return replaceSessionEntry(
      { agentId: "main", sessionKey, storePath: sessionTarget.storePath },
      {
        sessionId: "parity-session",
        updatedAt: Date.now(),
        permissionMode: "full",
        execHost: "gateway",
        ...fields,
      },
    );
  }

  function execTool(runId: string) {
    return createExecTool({
      ...projectEffectiveExecPolicy({
        base: config.tools!.exec!,
        permissionPolicy: { mode: "full" },
      }),
      config,
      cwd: state.workspaceDir,
      agentId: "main",
      sessionKey,
      runId,
      allowBackground: false,
    });
  }

  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "voice-permission-parity", applyEnv: true });
    config = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      tools: { exec: { host: "gateway", mode: "full" } },
    };
    await state.writeConfig(config);
    sessionTarget = await prepareTalkSessionTarget(config, sessionKey);
    await writeSession();
    voiceSessionId = await createOrResumeClientVoiceSession({
      agentId: "main",
      sessionKey,
      origin: "client",
      transcriptCapable: true,
    });
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
  });
  afterAll(async () => {
    await flushClientVoiceSessionWrites({ agentId: "main", voiceSessionId });
    clientVoiceSessionTesting.reset();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  it("uses configured ownership without admin and the session-pinned node/cwd", async () => {
    const ownerClient = sharingPolicyClient({
      user: "configured-owner",
      deviceId: "owner-reviewer",
      scopes: ["operator.read", "operator.write"],
    });
    const cfg: OpenClawConfig = { ...config, commands: { ownerAllowFrom: ["configured-owner"] } };
    const cwd = path.join(state.workspaceDir, "task-worktree");
    await fs.mkdir(cwd, { recursive: true });
    await writeSession({
      permissionMode: "guarded",
      spawnedCwd: cwd,
      sessionRoot: cwd,
      execHost: "node",
      execNode: "session-node",
      execCwd: "/node/task",
      delivery: normalizeSessionDeliveryState({
        context: { channel: "discord", to: "old-target", accountId: "old-account" },
      }),
    });
    model.run.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      expect(params).toMatchObject({
        senderIsOwner: true,
        approvalReviewerDeviceId: "owner-reviewer",
        messageProvider: "webchat",
        workspaceDir: cwd,
        cwd,
        sessionRoot: cwd,
        permissionMode: "guarded",
        execOverrides: { host: "node", node: "session-node", nodeCwd: "/node/task" },
      });
      return { payloads: [{ text: "Prepared." }], meta: {} };
    });
    const runner = createRunner({
      config: cfg,
      authority: resolveTalkAgentConsultAuthority(ownerClient.connect.scopes, ownerClient),
    });
    expect(
      await runner.runArgs({
        question: "Do the requested work",
        senderIsOwner: false,
        execHost: "gateway",
        confirmationId: "model-only-yes",
      }),
    ).toEqual({ text: "Prepared." });
  });

  it("fences the native effect when the retained authenticated source is revoked", async () => {
    await writeSession();
    const { context, source, retained } = await retainSource();
    const marker = path.join(state.workspaceDir, "revoked-effect");
    model.run.mockImplementationOnce(async (params: RunEmbeddedAgentParams) => {
      assert(params.preparedRunAdmission, "Missing Talk admission");
      const admittedRunContext = await params.preparedRunAdmission.admit(
        "plugin-harness",
        "parity-native-host",
      );
      const host = createAgentHarnessHostCapabilities({
        pluginId: "parity-native-host",
        attempt: {
          runId: params.runId,
          agentId: "main",
          sessionId: params.sessionId,
          sessionKey,
          workspaceDir: state.workspaceDir,
          admittedRunContext,
        },
      });
      const [tool] = host.capabilities.bindToolSurface([execTool(params.runId)]);
      assert(tool, "Missing admitted tool");
      try {
        // Revocation is an owner event, not a model parameter or a mock policy answer.
        invalidateGatewayDeviceRevocation(context, "parity-caller", "operator");
        await expect(
          tool.execute("revoked-call", {
            command: "printf effect > revoked-effect",
            workdir: state.workspaceDir,
          }),
        ).rejects.toThrow(/authority|active/);
        await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        host.close();
      }
      return { payloads: [{ text: "Denied." }], meta: {} };
    });
    try {
      const runner = createRunner({ context, runAuthority: retained });
      expect(await runner.runArgs({ question: "Carry out the action" })).toEqual({
        text: "Denied.",
      });
    } finally {
      retained.release();
      source.release();
    }
  });
  // #185942: a stale session's consult reset commits only for a current caller; a real revocation
  // between the freshness check and the write leaves the session untouched and starts no run.
  it.each([false, true])(
    "preserves queued browser requests across a reset for a current caller (revoked=%s)",
    async (revoke) => {
      model.run.mockReset();
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
      const stale = { sessionStartedAt: twoDaysAgo, lastInteractionAt: twoDaysAgo };
      await writeSession({ sessionStartedAt: Date.now(), lastInteractionAt: Date.now() });
      const { context, source, retained } = await retainSource();
      const previousSession = config.session;
      config.session = { reset: { mode: "daily", atHour: 4 } };
      const scope = {
        agentId: "main",
        sessionKey,
        sessionId: "parity-session",
        storePath: sessionTarget.storePath,
      };
      const manager = SessionManager.inMemory(state.workspaceDir);
      manager.newSession({ id: scope.sessionId });
      const messages = [
        "PELICAN-DAY1",
        ...Array.from({ length: 9 }, (_, index) => `Retained message ${index + 2}.`),
      ];
      for (const [index, text] of messages.entries()) {
        await manager.appendMessageAsync(
          index % 2 === 1
            ? makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: index + 1 })
            : { role: "user", content: text, timestamp: index + 1 },
        );
      }
      await replaceTranscriptEvents(scope, manager.getPersistedEntries());
      await waitForSessionTranscriptProjection(scope);
      const initialItems = await readTalkRealtimeInitialItems(sessionTarget, () => {}, config);
      expect(initialItems.map((item) => item.text)).toEqual(messages);
      await writeSession({ lifecycleRevision: "before-reset", ...stale });
      let staleChecks = 0;
      freshness.afterStaleCheck = () => {
        staleChecks += 1;
        if (revoke) {
          invalidateGatewayDeviceRevocation(context, "parity-caller", "operator");
        }
      };
      model.run
        .mockResolvedValueOnce({ payloads: [{ text: "Answered A." }], meta: {} })
        .mockResolvedValueOnce({ payloads: [{ text: "Answered B." }], meta: {} });
      const revision = () =>
        loadSessionEntry({ agentId: "main", sessionKey, storePath: sessionTarget.storePath })
          ?.lifecycleRevision;
      const flush = createDeferredCore();
      const response = createDeferredCore<unknown>();
      const complete = createDeferredCore();
      const outcomes: Array<{ callId: string; result: unknown }> = [];
      const secondPreparing = createDeferredCore();
      let freshnessReads = 0;
      freshness.beforeCheck = async () => {
        if (++freshnessReads === 1) {
          await secondPreparing.promise;
        } else if (freshnessReads === 2) {
          secondPreparing.resolve();
          await response.promise;
        }
      };
      const runner = createRunner({
        context,
        runAuthority: retained,
        ownerConnId: "parity-conn",
        initialItems,
      });
      const { owner, bridge } = createControlFixture({
        voiceSessionId,
        connId: "parity-conn",
        sessionTarget,
        runToolAgentConsult: runner.runArgs,
        runAgentConsult: runner.runOwnedArgs,
        flushTranscript: async () => {
          await flush.promise;
        },
      });
      owner.control.bindBridge({
        ...bridge,
        submitToolResult: async (callId, result) => {
          outcomes.push({ callId, result });
          response.resolve(result);
          if (outcomes.length === 2) {
            complete.resolve();
          }
        },
      });
      owner.activate();
      try {
        assert(owner.control.onToolCall);
        for (const request of ["A", "B"]) {
          owner.control.onToolCall({
            itemId: `reset-item-${request}`,
            callId: `reset-consult-${request}`,
            name: "openclaw_agent_consult",
            args: { question: `Question ${request}` },
          });
        }
        flush.resolve();
        await complete.promise;
        // Persistence first: a revoked caller's reset never commits.
        expect(revision() === "before-reset").toBe(revoke);
        expect(outcomes).toEqual(
          ["A", "B"].map((request) => ({
            callId: `reset-consult-${request}`,
            result: revoke
              ? {
                  error: expect.stringContaining(
                    "Talk caller source authority is no longer active",
                  ),
                }
              : { result: `Answered ${request}.` },
          })),
        );
        expect(model.run).toHaveBeenCalledTimes(revoke ? 0 : 2);
        for (const [index, [params]] of model.run.mock.calls.entries()) {
          expect(params.prompt).toContain(`Question ${index === 0 ? "A" : "B"}`);
          expect(params.prompt).not.toContain("PELICAN-DAY1");
          for (const text of messages.slice(-6)) {
            expect(params.prompt).toContain(text);
          }
          expect(params.sessionTarget).toMatchObject({
            agentId: "main",
            sessionKey,
            storePath: sessionTarget.storePath,
          });
        }
        expect(staleChecks).toBe(revoke ? 2 : 3);
      } finally {
        flush.resolve();
        response.resolve(undefined);
        secondPreparing.resolve();
        await owner.close();
        freshness.beforeCheck = undefined;
        freshness.afterStaleCheck = undefined;
        config.session = previousSession;
        model.run.mockReset();
        retained.release();
        source.release();
      }
    },
  );

  it("retains but does not accept a pending voice-creation request", async () => {
    let pendingCurrent = true;
    const { source, retained } = await retainSource(() => pendingCurrent);
    try {
      // Provider creation has not committed a logical voice owner yet. A tentative
      // credential change must still fence this request, not only committed revocation.
      pendingCurrent = false;
      expect(source.isCurrent()).toBe(false);
      expect(() => retained.accept()).toThrow("no longer current for admission");
      pendingCurrent = true;
      retained.accept();
      pendingCurrent = false;
      // Once the logical call commits, accepted work retains committed source
      // custody independently of a later retired request or audio transport.
      expect(source.isCurrent()).toBe(true);
    } finally {
      retained.release();
      source.release();
    }
  });
  it("does not manufacture reply authority when the authenticated caller is missing", () => {
    expect(() =>
      prepareTalkClientControlAuthority({
        config,
        sessionTarget,
        source: "reply",
        authority: { senderIsOwner: false },
        agentRuntime: createPluginRuntime().agent,
      }),
    ).toThrow("Talk chat caller authority is unavailable");
  });
});
