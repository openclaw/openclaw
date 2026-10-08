import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, test, vi } from "vitest";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  recoverRestartAbortedMainSessions,
  markStartupOrphanedMainSessionsForRecovery,
} from "../agents/main-session-recovery/main-session-restart-recovery.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import type { StartChatDispatchParams } from "./server-methods/chat-send-agent-dispatch.types.js";
import { createGitWorkspace } from "./server.sessions.create.projects.test-support.js";
import { setupSessionCreateTestHarness } from "./server.sessions.create.test-support.js";
import { agentCommandMock, rpcReq, testState } from "./test-helpers.js";

const dispatch = vi.hoisted(() => ({ start: vi.fn<(params: StartChatDispatchParams) => void>() }));
vi.mock("./server-methods/chat-send-agent-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-send-agent-dispatch.js")>()),
  startChatDispatch: dispatch.start,
}));
let workspace: string;
const { createSessionStoreDir, openClient } = setupSessionCreateTestHarness(async (makeTempDir) => {
  workspace = await createGitWorkspace(makeTempDir("openclaw-initial-turn-durability-"));
});

test.for([
  { id: "openclaw-control-ui", mode: "webchat", worktree: true },
  { id: "openclaw-control-ui", mode: "webchat", worktree: false },
  { id: "cli", mode: "cli", worktree: true },
  { id: "cli", mode: "cli", worktree: false },
] as const)(
  "recovers an acknowledged $id first turn (worktree=$worktree) before dispatch",
  async ({ id, mode, worktree }) => {
    testState.agentConfig = { workspace };
    testState.gatewayControlUi = { allowedOrigins: ["http://localhost"] };
    const { storePath } = await createSessionStoreDir();
    const { ws } = await openClient({
      client: { id, mode, platform: "test", version: "1.0.0" },
      browserOrigin: mode === "webchat" ? "http://localhost" : undefined,
    });
    const key = `agent:main:dashboard:durable-${id}-${worktree}`;
    const message = "Reply with exactly: retained first message.";
    dispatch.start.mockClear();
    agentCommandMock.mockImplementation(async (raw) => {
      const options = raw as AgentCommandGatewayIngressOpts;
      expect(options.pinnedWidgetAuthoring).toBe(mode === "webchat" ? true : undefined);
      const entry = expectDefined(
        loadSessionEntry({ agentId: "main", sessionKey: key, storePath }),
        "session at execution",
      );
      expect(entry.pendingWorktree).toBeUndefined();
      if (worktree) {
        expect(entry.worktree?.id).toBeDefined();
        expect(entry.spawnedCwd).not.toBe(workspace);
      }
      await options.userTurnTranscriptRecorder?.persistApproved();
    });
    let captured: StartChatDispatchParams | undefined;
    try {
      const created = await rpcReq<{
        key: string;
        sessionId: string;
        runId: string;
        runStarted: boolean;
      }>(ws, "sessions.create", {
        agentId: "main",
        key,
        cwd: workspace,
        worktree,
        worktreeName: worktree ? `durability-${id}` : undefined,
        message,
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      captured = expectDefined(dispatch.start.mock.calls[0]?.[0], "accepted dispatch");
      const target = { agentId: "main", sessionKey: key, storePath };
      const before = expectDefined(loadSessionEntry(target), "created session");
      expect(before.pendingWorktree !== undefined).toBe(worktree);
      const followup = "Also retain this queued follow-up.";
      if (worktree) {
        const sent = await rpcReq(ws, "chat.send", {
          sessionKey: key,
          message: followup,
          idempotencyKey: `followup-${id}`,
        });
        expect(sent.ok, JSON.stringify(sent)).toBe(true);
        const pending = await rpcReq<{ pendingInputs: { items: unknown[] } }>(ws, "chat.history", {
          sessionKey: key,
        });
        expect(JSON.stringify(pending.payload?.pendingInputs.items)).toContain(followup);
      }
      // Drop process-only dispatches; do not run their terminal/error persistence.
      const released = getSessionWorkAdmissionRelease({ scope: storePath, identities: [key] });
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      await released;
      const cfg = getRuntimeConfig();
      await markStartupOrphanedMainSessionsForRecovery({ cfg });
      const recovery = await recoverRestartAbortedMainSessions({
        cfg,
        gatewayRuntime: expectDefined(captured.context.recoveryRuntime, "Gateway recovery owner"),
      });
      expect(
        recovery,
        JSON.stringify({
          entry: loadSessionEntry(target),
          outcomes: [...captured.context.dedupe.values()],
        }),
      ).toMatchObject({
        settled: 1,
        failed: 0,
      });
      expect(agentCommandMock).toHaveBeenCalledOnce();
      const after = expectDefined(loadSessionEntry(target), "recovered session");
      expect(after.pendingWorktree).toBeUndefined();
      expect(after.sessionId).toBe(created.payload?.sessionId);
      const transcript = await loadTranscriptEvents({ ...target, sessionId: after.sessionId });
      expect(transcript.filter((event) => JSON.stringify(event).includes(message))).toHaveLength(1);
      const history = await rpcReq<{
        messages: unknown[];
        pendingInputs: { items: Array<{ state: string; message: unknown }> };
      }>(ws, "chat.history", {
        sessionKey: key,
      });
      expect(history.ok, JSON.stringify(history)).toBe(true);
      expect(JSON.stringify(history.payload?.messages)).toContain(message);
      if (worktree) {
        expect(history.payload?.pendingInputs.items).toMatchObject([{ state: "interrupted" }]);
        expect(JSON.stringify(history.payload?.pendingInputs.items)).toContain(followup);
        expect(JSON.stringify(history.payload?.messages)).not.toContain(followup);
      }
    } finally {
      for (const [turn] of dispatch.start.mock.calls) {
        turn.replyAdmissionTicket?.release();
        turn.admission.cleanupAdmittedRun();
        clearAgentRunContext(turn.session.clientRunId, turn.admission.lifecycleGeneration);
      }
      ws.close();
      const owned = await managedWorktrees.findLiveByOwner("session", key);
      if (owned) {
        await managedWorktrees.remove({
          id: owned.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
      testState.agentConfig = undefined;
    }
  },
);
