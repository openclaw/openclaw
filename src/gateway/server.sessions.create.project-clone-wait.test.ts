import { afterEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGit } from "../agents/worktrees/git.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import * as backoff from "../infra/backoff.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { createChatRunState } from "./server-chat-state.js";
import { createRequestGate } from "./server-methods.request-gate.test-support.js";
import {
  controlUiClient,
  expectChatEvent,
  expectPreparedProject,
  initializeRepository,
  removeOwnedSessionWorktree,
  settleWorkspaceRuns,
  successfulSessionRequest as request,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  dispatchInboundMessageMock.mockReset();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const readEntry = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ agentId: "main", sessionKey, storePath });

test.for([{ mode: "resume" }, { mode: "cancel" }])(
  "prolonged clone contention keeps the original GitHub session pending ($mode)",
  async ({ mode }, { signal }) => {
    const root = tempDirs.make("openclaw-clone-wait-");
    const workspace = await initializeRepository(root, "workspace");
    const projectRoot = await initializeRepository(root, "project");
    const gitUrl = "https://github.com/example/clone-wait.git";
    await requireGit(projectRoot, ["remote", "set-url", "origin", gitUrl]);
    testState.agentConfig = { workspace };
    const { storePath } = await createSessionStoreDir();
    const project = await registerProjectRegistry({ path: projectRoot });
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });
    const broadcast = vi.fn();
    const context = { broadcast, dedupe: new Map(), chatRunState: createChatRunState() };
    const holder = createRequestGate();
    const held = withOpenClawStateLease(
      {
        scope: "projects.clone",
        key: sha256HexPrefixCore(gitUrl, 16),
        database: { scope: "shared" },
        leaseMs: 60_000,
        waitMs: 0,
        signal,
      },
      holder.pause,
    );
    const continuing = createRequestGate();
    const now = performance.now.bind(performance);
    let elapsed = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
    const sleepSpy = vi.spyOn(backoff, "sleepWithAbort");
    let settled: Promise<void> | undefined;
    let key: string | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(holder.entered, held, "Clone holder never acquired custody"),
        signal,
      );
      sleepSpy.mockImplementation(async (_delay, waitSignal) => {
        // Advance the waiter only. The lease's wall clock and real SQLite holder stay active.
        if (!elapsed) {
          elapsed = 31_000;
        } else {
          await withinTest(continuing.pause(), waitSignal ?? signal);
        }
      });
      const message = "Inspect the project once its clone is available";
      const created = await request<{
        key: string;
        runId: string;
        sessionId: string;
      }>(
        "sessions.create",
        {
          agentId: "main",
          message,
          projectGitUrl: gitUrl,
          worktree: true,
          worktreeBaseRef: "main",
          worktreeName: "clone-wait",
        },
        { ...controlUiClient, context },
      );
      key = created.key;
      settled = settleWorkspaceRuns(context, storePath, key);
      const terminal = settled.then(() => {
        const error = broadcast.mock.calls.find(
          ([event, payload]) => event === "chat" && payload.state === "error",
        );
        if (error) {
          throw new Error(error[1].errorMessage);
        }
      });
      await withinTest(
        awaitGateBeforeSettlement(
          continuing.entered,
          terminal,
          "The original chat failed before the busy clone was released",
        ),
        signal,
      );
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(readEntry(storePath, key)).toMatchObject({
        sessionId: created.sessionId,
        pendingProjectGitUrl: gitUrl,
      });
      if (mode === "cancel") {
        const aborted = await request<{ aborted: boolean; runIds: string[] }>(
          "chat.abort",
          { agentId: "main", sessionKey: key, runId: created.runId },
          { ...controlUiClient, context },
        );
        expect(aborted).toMatchObject({ aborted: true, runIds: [created.runId] });
        await withinTest(settled, signal);
        expectChatEvent(broadcast, { runId: created.runId, sessionKey: key, state: "aborted" });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
        return;
      }
      sleepSpy.mockRestore();
      holder.release();
      await held;
      continuing.release();
      await settled;
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(dispatchInboundMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({
          ctx: expect.objectContaining({ RawBody: message, SessionKey: key }),
        }),
      );
      expectPreparedProject(readEntry(storePath, key), created.sessionId, project, projectRoot);
      expectChatEvent(broadcast, { runId: created.runId, sessionKey: key, state: "final" });
    } finally {
      sleepSpy.mockRestore();
      clock.mockRestore();
      holder.release();
      continuing.release();
      await held;
      await settled;
      await removeOwnedSessionWorktree(key);
    }
  },
);
