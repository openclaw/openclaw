import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { retainSessionActorEntryFacts } from "../../config/sessions/session-actor-replica.js";
import { readRetainedSessionEntryFacts } from "../../config/sessions/session-entry-read-facts.js";
import { readSessionEntriesFromStoreInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import * as fsSafe from "../../infra/fs-safe.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import { sessionsFilesHandlers } from "./sessions-files.js";
import {
  createSessionFileDownloadClient,
  createSessionFilesHandlerInvoker,
} from "./sessions-files.test-support.js";
import type { GatewayClient } from "./types.js";

const hooks = vi.hoisted(() => ({
  duringSettlement: undefined as (() => Promise<void>) | undefined,
}));

// Real settlement; the hook changes session state or cache residency while it is in progress.
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

async function dispatch(
  method: "sessions.files.list" | "sessions.files.get" | "sessions.files.download",
  filePath?: string,
  client: GatewayClient | null = null,
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: {
      type: "req",
      id: method,
      method,
      params: { sessionKey: key, agentId: "main", ...(filePath ? { path: filePath } : {}) },
    },
    client,
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

function seedReplicaPressure(env: NodeJS.ProcessEnv) {
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  const siblingKeys = Array.from(
    { length: 128 },
    (_, index) => `agent:main:file-reader-pressure-${index}`,
  );
  runOpenClawAgentWriteTransaction(
    (writer) => {
      for (const sessionKey of siblingKeys) {
        writeSessionEntry(writer, sessionKey, { sessionId: sessionKey, updatedAt: 1 });
      }
    },
    { agentId: "main", path: database.path, env },
  );
  const read = (sessionKeys: string[]) =>
    readSessionEntriesFromStoreInWorker({
      agentId: "main",
      storePath: database.path,
      env,
      sessionKeys,
    });
  const retained = () =>
    readRetainedSessionEntryFacts(
      { agentId: "main", path: database.path },
      { sessionKeys: [key], projection: "exact", snapshotFields: ["skillsSnapshot"] },
    );
  return async () => {
    const selected = await read([key]);
    expect(retained()?.entries[0]?.entry.sessionId).toBe("worktree-session");
    const first = await read(siblingKeys.slice(0, 64));
    // A legitimate metadata publication can refresh the target between worker reads.
    await sessions.upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      { ...selected.entries[0]!.entry, label: "Updated while reading files" },
    );
    const second = await read(siblingKeys.slice(64));
    const identity = second.databaseIdentity;
    assert(identity);
    // Install the committed sibling rows together so eviction cannot depend on read timing.
    retainSessionActorEntryFacts(
      {
        kind: "file",
        physicalIdentity: identity.identity,
        nativeLocation: database.path,
        birthtime: identity.birthtime,
      },
      [...first.entries, ...second.entries].map(({ sessionKey, entry }) => ({
        sessionKey,
        facts: { entry, snapshots: "full" },
      })),
      identity.incarnation,
    );
    expect(retained()).toBeUndefined();
  };
}

describe("sessions.files for managed-worktree sessions", () => {
  it("refuses a changed file lookup root inside the same managed workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      const original = { ...entry, spawnedWorkspaceDir: state.workspaceDir };
      await sessions.upsertSessionEntryCore({ agentId: "main", sessionKey: key }, original);
      const source = {
        workspaceId: entry.worktree.id,
        root: state.workspaceDir,
        fileRoot: entry.spawnedCwd,
      };
      const opened = await dispatch("sessions.files.get", "preview.html");
      expect(opened.mock.calls[0]?.[1]).toMatchObject({
        source,
        file: { content: "<h1>boo</h1>\n" },
      });
      const replacement = path.join(state.workspaceDir, "replacement");
      fs.mkdirSync(replacement);
      fs.writeFileSync(path.join(replacement, "preview.html"), "<h1>boo</h1>\n");
      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { ...original, spawnedCwd: replacement },
      );
      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const save = {
        sessionKey: key,
        path: "preview.html",
        content: "new draft",
        expectedHash: createHash("sha256").update("<h1>boo</h1>\n").digest("hex"),
        expectedSource: source,
      };
      await expect(invoke("sessions.files.set", save)).rejects.toMatchObject({
        error: { details: { type: "session_file_source_changed" } },
      });
      expect(fs.readFileSync(path.join(replacement, "preview.html"), "utf8")).toBe(
        "<h1>boo</h1>\n",
      );
      const freshSource = { ...source, fileRoot: replacement };
      const fresh = await dispatch("sessions.files.get", "preview.html");
      expect(fresh.mock.calls[0]?.[1]).toMatchObject({ source: freshSource });
      expect(
        await invoke("sessions.files.set", { ...save, expectedSource: freshSource }),
      ).toMatchObject([{ ok: true }]);
      expect(fs.readFileSync(path.join(replacement, "preview.html"), "utf8")).toBe("new draft");
    });
  });

  it.each(["workspace", "authorization"] as const)(
    "preserves the file when %s changes during a source-aware save",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const entry = await seedWorktreeSession(state.workspaceDir);
        let authorized = true;
        const revoked = new Error("editor authorization revoked");
        const assertCurrent = () => {
          if (!authorized) {
            throw revoked;
          }
        };
        const createRoot = fsSafe.root;
        using rootSpy = vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
          const root = await createRoot(...args);
          const write = root.write.bind(root);
          root.write = async (...writeArgs) => {
            if (change === "workspace") {
              await sessions.upsertSessionEntryCore(
                { agentId: "main", sessionKey: key },
                { ...entry, worktree: { ...entry.worktree, id: "wt-2" } },
              );
            } else {
              authorized = false;
            }
            return write(...writeArgs);
          };
          return root;
        });
        const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
        const saving = invoke(
          "sessions.files.set",
          {
            sessionKey: key,
            path: "preview.html",
            content: "unapproved replacement",
            expectedHash: createHash("sha256").update("<h1>boo</h1>\n").digest("hex"),
            expectedSource: {
              workspaceId: entry.worktree.id,
              root: entry.spawnedCwd,
              fileRoot: entry.spawnedCwd,
            },
          },
          {},
          {
            sessionMutationAuthorization: {
              assertCurrent,
              assertTargetCurrent: assertCurrent,
            },
          },
        );
        await expect(saving).rejects.toThrow(
          change === "workspace" ? "Session workspace changed during file access" : revoked,
        );
        expect(rootSpy).toHaveBeenCalled();
        expect(fs.readFileSync(path.join(entry.spawnedCwd, "preview.html"), "utf8")).toBe(
          "<h1>boo</h1>\n",
        );
      });
    },
  );

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

  it("keeps a durable file preview readable after its cached session row is evicted", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const evict = seedReplicaPressure(state.env);
      await seedWorktreeSession(state.workspaceDir);
      hooks.duringSettlement = async () => {
        hooks.duringSettlement = undefined;
        await evict();
      };
      try {
        const response = await dispatch("sessions.files.get", "preview.html");
        expect(hooks.duringSettlement).toBeUndefined();
        expect(response).toHaveBeenCalledOnce();
        expect(response.mock.calls[0]?.[2]).toBeUndefined();
        expect(response.mock.calls[0]?.[0]).toBe(true);
        expect(response.mock.calls[0]?.[1]).toMatchObject({
          file: { content: "<h1>boo</h1>\n" },
        });
      } finally {
        hooks.duringSettlement = undefined;
      }
    });
  });

  it("keeps a download grant through cache eviction and revokes it after a workspace change", async () => {
    hooks.duringSettlement = undefined;
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const evict = seedReplicaPressure(state.env);
      const entry = await seedWorktreeSession(state.workspaceDir);
      using connection = createSessionFileDownloadClient();
      const response = await dispatch("sessions.files.download", "preview.html", connection.client);
      expect(response).toHaveBeenCalledOnce();
      expect(response.mock.calls[0]?.[2]).toBeUndefined();
      expect(response.mock.calls[0]?.[0]).toBe(true);
      const url = response.mock.calls[0]?.[1]?.url;
      expect(url).toEqual(expect.any(String));

      await evict();
      const downloaded = await connection.fetch(url);
      expect(downloaded.response.statusCode).toBe(200);
      expect(Buffer.from(downloaded.body ?? []).toString()).toBe("<h1>boo</h1>\n");

      await sessions.upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { ...entry, updatedAt: 2, worktree: { ...entry.worktree, id: "wt-2" } },
      );
      expect((await connection.fetch(url)).response.statusCode).toBe(404);
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
