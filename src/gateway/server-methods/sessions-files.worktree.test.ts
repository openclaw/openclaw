import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sessionsFilesHandlers } from "./sessions-files.js";

const hooks = vi.hoisted(() => ({
  duringSettlement: undefined as (() => Promise<void>) | undefined,
}));

// Real settlement; the hook only simulates a session change while it is in progress.
vi.mock("../worker-environments/local-workspace-projection.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../worker-environments/local-workspace-projection.js")>();
  return {
    ...actual,
    withSettledLocalWorkspacePath: (async (params, operation) => {
      await hooks.duringSettlement?.();
      return await actual.withSettledLocalWorkspacePath(params, operation);
    }) satisfies typeof actual.withSettledLocalWorkspacePath,
  };
});

const key = "agent:main:worktree-files";

async function dispatch(method: "sessions.files.list" | "sessions.files.get", filePath?: string) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: method,
      method,
      params: { sessionKey: key, agentId: "main", ...(filePath ? { path: filePath } : {}) },
    },
    client: null,
    context: createDirectChatContext({ getRuntimeConfig: () => ({}) }),
    respond,
    isWebchatConnect: () => false,
    extraHandlers: sessionsFilesHandlers,
  });
  return respond;
}

async function seedWorktreeSession(workspaceDir: string) {
  setRuntimeConfigSnapshot({});
  const worktreeDir = path.join(workspaceDir, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(path.join(worktreeDir, "preview.html"), "<h1>boo</h1>\n");
  const entry = {
    sessionId: "worktree-session",
    lifecycleRevision: "rev-1",
    updatedAt: 1,
    spawnedCwd: worktreeDir,
    worktree: { id: "wt-1", branch: "openclaw/test", repoRoot: workspaceDir },
  };
  await sessions.upsertSessionEntryCore({ agentId: "main", sessionKey: key }, entry);
  return entry;
}

describe("sessions.files for managed-worktree sessions", () => {
  it("reads files from a durable session's worktree", async () => {
    hooks.duringSettlement = undefined;
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await seedWorktreeSession(state.workspaceDir);

      const list = await dispatch("sessions.files.list");
      expect(list).toHaveBeenCalledOnce();
      expect(list.mock.calls[0]?.[2]).toBeUndefined();
      expect(list.mock.calls[0]?.[0]).toBe(true);

      const get = await dispatch("sessions.files.get", "preview.html");
      expect(get).toHaveBeenCalledOnce();
      expect(get.mock.calls[0]?.[2]).toBeUndefined();
      expect(get.mock.calls[0]?.[1]).toMatchObject({ file: { content: "<h1>boo</h1>\n" } });
    });
  });

  it("refuses the read when the session moves to another worktree during settlement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      hooks.duringSettlement = async () => {
        hooks.duringSettlement = undefined;
        await sessions.upsertSessionEntryCore(
          { agentId: "main", sessionKey: key },
          { ...entry, updatedAt: 2, worktree: { ...entry.worktree, id: "wt-2" } },
        );
      };
      try {
        const response = await dispatch("sessions.files.get", "preview.html");
        expect(hooks.duringSettlement).toBeUndefined();
        expect(response).toHaveBeenCalledOnce();
        expect(response.mock.calls[0]?.[0]).toBe(false);
        expect(response.mock.calls[0]?.[2]).toMatchObject({
          message: "Session workspace changed during file access",
        });
      } finally {
        hooks.duringSettlement = undefined;
      }
    });
  });
});
