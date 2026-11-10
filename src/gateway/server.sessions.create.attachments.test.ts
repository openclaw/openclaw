import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareSandboxWorkspaceForSession } from "../agents/sandbox/context.js";
import { withFullRuntimeReplyConfig } from "../auto-reply/reply/get-reply-fast-path.js";
import * as replyRun from "../auto-reply/reply/get-reply-run.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  controlUiClient,
  initializeRepository,
  removeOwnedSessionWorktree,
  settleWorkspaceRuns,
  successfulSessionRequest,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, gatewayReplyMock, testState } from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  gatewayReplyMock.mockReset();
  dispatchInboundMessageMock.mockReset();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});

test.each(["initial", "follow-up"] as const)(
  "%s attachment reaches the prepared worktree with its original bytes",
  async (turn) => {
    const root = temporaryDirs.make("openclaw-worktree-attachment-");
    const workspace = await initializeRepository(root, "project");
    testState.agentConfig = {
      workspace,
      sandbox: { mode: "all", scope: "session", workspaceAccess: "none" },
    };
    const { storePath } = await createSessionStoreDir();
    const context = { broadcast: vi.fn() };
    const options = { ...controlUiClient, context };
    const bytes = Buffer.from("order,total\nMarch-1,19.95\nMarch-2,25.00\n");
    const input = {
      message: "Summarize the attached orders.",
      attachments: [
        { fileName: "orders.csv", mimeType: "text/csv", content: bytes.toString("base64") },
      ],
    };
    // Keep public input admission, workspace preparation, and reply staging real.
    // Only model execution is replaced with an observation of its prepared input.
    gatewayReplyMock.mockImplementation((ctx, opts, cfg) =>
      getReplyFromConfig(ctx, opts, withFullRuntimeReplyConfig(cfg ?? getRuntimeConfig())),
    );
    dispatchInboundMessageMock.mockReset();
    const run = vi.spyOn(replyRun, "runPreparedReply").mockResolvedValue(undefined);
    let key: string | undefined;
    try {
      const created = await successfulSessionRequest<{ key: string }>(
        "sessions.create",
        { agentId: "main", worktree: true, ...(turn === "initial" ? input : {}) },
        options,
      );
      key = created.key;
      if (turn === "follow-up") {
        await successfulSessionRequest(
          "chat.send",
          { ...input, sessionKey: key, idempotencyKey: "follow-up-attachment" },
          options,
        );
      }
      await settleWorkspaceRuns(context, storePath, key);
      const errors = context.broadcast.mock.calls.filter(
        ([event, payload]) => event === "chat" && payload.state === "error",
      );
      expect(errors).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
      const prepared = run.mock.calls[0]![0];
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      assert(entry?.worktree, "the public create request did not bind a worktree");
      assert(entry.spawnedCwd, "the bound worktree has no execution directory");
      expect(entry.pendingWorktree).toBeUndefined();
      const media = prepared.sessionCtx.media?.[0];
      assert(media?.path, "the prepared turn lost its attachment");
      using destination = await prepareSandboxWorkspaceForSession({
        config: getRuntimeConfig(),
        agentId: "main",
        sessionKey: key,
        workspaceDir: entry.spawnedCwd,
      });
      assert(destination, "the guest worktree has no sandbox workspace");
      expect(path.isAbsolute(media.path)).toBe(false);
      await expect(
        fs.readFile(path.resolve(destination.workspace.workspaceDir, media.path)),
      ).resolves.toEqual(bytes);
    } finally {
      await settleWorkspaceRuns(context, storePath, key, true);
      await removeOwnedSessionWorktree(key);
      run.mockRestore();
    }
  },
);
