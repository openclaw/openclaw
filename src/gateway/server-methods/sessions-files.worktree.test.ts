import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { prepareSessionFileWorkspace } from "../session-file-workspace.js";
import * as workspaceRoots from "../session-workspace-roots.js";
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
    checkpointLocalWorkspacePath: (async (params) => {
      await hooks.duringSettlement?.();
      return await actual.checkpointLocalWorkspacePath(params);
    }) satisfies typeof actual.checkpointLocalWorkspacePath,
  };
});

const key = "agent:main:worktree-files";
const scope = { agentId: "main", sessionKey: key };
const preview = "<h1>boo</h1>\n";
const expectedHash = createHash("sha256").update(preview).digest("hex");
const file = (root: string) => path.join(root, "preview.html");
const readPreview = (root: string) => fs.readFileSync(file(root), "utf8");
afterEach(() => {
  hooks.duringSettlement = undefined;
});

function successful(response: Awaited<ReturnType<typeof dispatch>>) {
  expect(response).toHaveBeenCalledOnce();
  expect(response.mock.calls[0]?.[2]).toBeUndefined();
  expect(response.mock.calls[0]?.[0]).toBe(true);
  return response.mock.calls[0]?.[1];
}

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
  fs.writeFileSync(file(worktreeDir), preview);
  const entry = {
    sessionId: "worktree-session",
    lifecycleRevision: "rev-1",
    updatedAt: 1,
    spawnedCwd: worktreeDir,
    worktree: { id: "wt-1", branch: "openclaw/test", repoRoot: workspaceDir },
  };
  await sessions.upsertSessionEntryCore(scope, entry);
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
    await sessions.upsertSessionEntryCore(scope, {
      ...selected.entries[0]!.entry,
      label: "Updated while reading files",
    });
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
  it("derives one current workspace policy per admission and revalidation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      const cfg = {
        agents: { defaults: { sandbox: { workspaceRoot: state.path("sandboxes") } } },
      };
      using roots = vi.spyOn(workspaceRoots, "resolveSessionWorkspaceRoots");
      const workspace = await prepareSessionFileWorkspace(cfg, "main", key, entry);
      expect(workspace).toMatchObject({ root: entry.spawnedCwd, historical: false });
      expect(roots).toHaveBeenCalledOnce();
      roots.mockClear();
      workspace.assertCurrent(cfg, entry);
      expect(roots).toHaveBeenCalledOnce();

      cfg.agents.defaults.sandbox.workspaceRoot = state.path("replacement-sandboxes");
      expect(() => workspace.assertCurrent(cfg, entry)).toThrow(
        "Session workspace changed during file access",
      );
      cfg.agents.defaults.sandbox.workspaceRoot = state.path("sandboxes");
      expect(() =>
        workspace.assertCurrent(cfg, {
          ...entry,
          worktree: { ...entry.worktree, id: "replacement-worktree" },
        }),
      ).toThrow("Session workspace changed during file access");
    });
  });

  it("refuses a changed file lookup root inside the same managed workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      const original = { ...entry, spawnedWorkspaceDir: state.workspaceDir };
      await sessions.upsertSessionEntryCore(scope, original);
      const source = {
        workspaceId: entry.worktree.id,
        root: state.workspaceDir,
        fileRoot: entry.spawnedCwd,
      };
      successful(await dispatch("sessions.files.list"));
      const opened = await dispatch("sessions.files.get", "preview.html");
      expect(opened.mock.calls[0]?.[1]).toMatchObject({
        source,
        file: { content: preview },
      });
      const replacement = path.join(state.workspaceDir, "replacement");
      fs.mkdirSync(replacement);
      fs.writeFileSync(file(replacement), preview);
      await sessions.upsertSessionEntryCore(scope, { ...original, spawnedCwd: replacement });
      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const save = {
        sessionKey: key,
        path: "preview.html",
        content: "new draft",
        expectedHash,
        expectedSource: source,
      };
      await expect(invoke("sessions.files.set", save)).rejects.toMatchObject({
        error: { details: { type: "session_file_source_changed" } },
      });
      expect(readPreview(replacement)).toBe(preview);
      const freshSource = { ...source, fileRoot: replacement };
      const fresh = await dispatch("sessions.files.get", "preview.html");
      expect(fresh.mock.calls[0]?.[1]).toMatchObject({ source: freshSource });
      expect(
        await invoke("sessions.files.set", { ...save, expectedSource: freshSource }),
      ).toMatchObject([{ ok: true }]);
      expect(readPreview(replacement)).toBe("new draft");
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
              await sessions.upsertSessionEntryCore(scope, {
                ...entry,
                worktree: { ...entry.worktree, id: "wt-2" },
              });
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
            expectedHash,
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
        expect(readPreview(entry.spawnedCwd)).toBe(preview);
      });
    },
  );

  it("keeps a durable file preview readable after its cached session row is evicted", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const evict = seedReplicaPressure(state.env);
      await seedWorktreeSession(state.workspaceDir);
      hooks.duringSettlement = async () => {
        hooks.duringSettlement = undefined;
        await evict();
      };
      const response = await dispatch("sessions.files.get", "preview.html");
      expect(hooks.duringSettlement).toBeUndefined();
      expect(successful(response)).toMatchObject({ file: { content: preview } });
    });
  });

  it("keeps a download grant through cache eviction and revokes it after a workspace change", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const evict = seedReplicaPressure(state.env);
      const entry = await seedWorktreeSession(state.workspaceDir);
      using connection = createSessionFileDownloadClient();
      const { url } = successful(
        await dispatch("sessions.files.download", "preview.html", connection.client),
      );
      expect(url).toEqual(expect.any(String));

      await evict();
      const downloaded = await connection.fetch(url);
      expect(downloaded.response.statusCode).toBe(200);
      expect(Buffer.from(downloaded.body ?? []).toString()).toBe(preview);

      await sessions.upsertSessionEntryCore(scope, {
        ...entry,
        updatedAt: 2,
        worktree: { ...entry.worktree, id: "wt-2" },
      });
      expect((await connection.fetch(url)).response.statusCode).toBe(404);
    });
  });

  it("refuses the read when the session moves to another worktree during settlement", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      hooks.duringSettlement = async () => {
        hooks.duringSettlement = undefined;
        await sessions.upsertSessionEntryCore(scope, {
          ...entry,
          updatedAt: 2,
          worktree: { ...entry.worktree, id: "wt-2" },
        });
      };
      const response = await dispatch("sessions.files.get", "preview.html");
      expect(hooks.duringSettlement).toBeUndefined();
      expect(response).toHaveBeenCalledOnce();
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]).toMatchObject({
        message: "Session workspace changed during file access",
      });
    });
  });
});
