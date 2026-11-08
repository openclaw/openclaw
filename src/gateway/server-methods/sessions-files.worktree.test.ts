import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
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
  duringReadPreparation: undefined as (() => Promise<void>) | undefined,
}));

// Real read preparation; change session state or cache residency across its await.
vi.mock("./session-file-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-file-read.js")>();
  return {
    ...actual,
    prepareSessionFileReadPath: (async (params) => {
      await hooks.duringReadPreparation?.();
      return await actual.prepareSessionFileReadPath(params);
    }) satisfies typeof actual.prepareSessionFileReadPath,
  };
});

const key = "agent:main:worktree-files";
const scope = { agentId: "main", sessionKey: key };
const preview = "<h1>boo</h1>\n";
const expectedHash = createHash("sha256").update(preview).digest("hex");
const file = (root: string) => path.join(root, "preview.html");
const readPreview = (root: string) => fs.readFileSync(file(root), "utf8");
afterEach(() => {
  hooks.duringReadPreparation = undefined;
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

async function seedRegisteredWorktreeConflictSession(workspaceDir: string) {
  setRuntimeConfigSnapshot({});
  const { localWorkspaceProjectionPath } =
    await import("../worker-environments/local-workspace-checkout.js");
  const worktreeId = randomUUID();
  const worktreeDir = path.join(workspaceDir, "worktree");
  fs.mkdirSync(worktreeDir, { recursive: true });
  fs.writeFileSync(file(worktreeDir), preview);
  const worktreeRecord = {
    id: worktreeId,
    name: "managed-wt",
    repoFingerprint: "test",
    repoRoot: workspaceDir,
    path: worktreeDir,
    branch: "openclaw/test",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: key,
    createdAt: 0,
    lastActiveAt: 0,
    snapshotRef: "snapshot-1",
  };
  await insertRegistryWorktree(process.env, worktreeRecord);
  const entry = {
    sessionId: "worktree-session",
    lifecycleRevision: "rev-1",
    updatedAt: 1,
    spawnedCwd: worktreeDir,
    worktree: worktreeRecord,
  };
  await sessions.upsertSessionEntryCore(scope, entry);
  const projectionDir = localWorkspaceProjectionPath({
    worktree: worktreeRecord,
    env: process.env,
  });
  return { entry, worktreeRecord, projectionDir };
}

async function seedPreparedWorktreeConflictSession(
  workspaceDir: string,
  options?: { subDir?: string; initialFile?: string; initialContent?: string },
) {
  setRuntimeConfigSnapshot({});
  const { requireGit } = await import("../../agents/worktrees/git.js");
  const { withLocalWorkspaceProjection } =
    await import("../worker-environments/local-workspace-projection.js");
  const repoDir = path.join(workspaceDir, "repo");
  const worktreeDir = path.join(workspaceDir, "worktree");
  fs.mkdirSync(repoDir, { recursive: true });
  await requireGit(repoDir, ["init", "--quiet", "-b", "main"]);
  await requireGit(repoDir, ["config", "user.name", "Test"]);
  await requireGit(repoDir, ["config", "user.email", "test@example.invalid"]);
  const initialRel = options?.initialFile ?? "preview.html";
  const initialData = options?.initialContent ?? "<h1>base</h1>\n";
  const repoFile = path.join(repoDir, initialRel);
  fs.mkdirSync(path.dirname(repoFile), { recursive: true });
  fs.writeFileSync(repoFile, initialData);
  await requireGit(repoDir, ["add", "."]);
  await requireGit(repoDir, ["commit", "--quiet", "-m", "base"]);
  await requireGit(repoDir, ["worktree", "add", "--quiet", "-b", "openclaw/test", worktreeDir]);

  const worktreeId = randomUUID();
  const worktreeRecord = {
    id: worktreeId,
    name: "managed-wt",
    repoFingerprint: "test",
    repoRoot: repoDir,
    path: worktreeDir,
    branch: "openclaw/test",
    baseRef: "main",
    ownerKind: "session" as const,
    ownerId: key,
    createdAt: 0,
    lastActiveAt: 0,
    snapshotRef: null,
  };
  await insertRegistryWorktree(process.env, worktreeRecord);
  const spawnedCwd = options?.subDir ? path.join(worktreeDir, options.subDir) : worktreeDir;
  const entry = {
    sessionId: "worktree-session",
    lifecycleRevision: "rev-1",
    updatedAt: 1,
    spawnedCwd,
    spawnedWorkspaceDir: worktreeDir,
    worktree: worktreeRecord,
  };
  await sessions.upsertSessionEntryCore(scope, entry);
  const owner = {
    agentId: "main",
    sessionKey: key,
    sessionId: entry.sessionId,
    lifecycleRevision: null,
    assertCurrent: () => {},
    worktree: worktreeRecord,
  };
  const projectionDir = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
  return { entry, worktreeRecord, projectionDir, owner, worktreeDir, repoDir };
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
      fs.writeFileSync(path.join(entry.spawnedCwd, "oversized.log"), "x".repeat(300 * 1024));
      const oversized = await dispatch("sessions.files.get", "oversized.log");
      expect(oversized.mock.calls[0]?.[0]).toBe(false);
      expect(oversized.mock.calls[0]?.[2]).toMatchObject({
        code: "INVALID_REQUEST",
        details: {
          type: "session_file_too_large",
          maxPreviewBytes: 256 * 1024,
          size: 300 * 1024,
          root: state.workspaceDir,
          source,
        },
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
      hooks.duringReadPreparation = async () => {
        hooks.duringReadPreparation = undefined;
        await evict();
      };
      const response = await dispatch("sessions.files.get", "preview.html");
      expect(hooks.duringReadPreparation).toBeUndefined();
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

  it("refuses the read when the session moves to another worktree during read preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const entry = await seedWorktreeSession(state.workspaceDir);
      hooks.duringReadPreparation = async () => {
        hooks.duringReadPreparation = undefined;
        await sessions.upsertSessionEntryCore(scope, {
          ...entry,
          updatedAt: 2,
          worktree: { ...entry.worktree, id: "wt-2" },
        });
      };
      const response = await dispatch("sessions.files.get", "preview.html");
      expect(hooks.duringReadPreparation).toBeUndefined();
      expect(response).toHaveBeenCalledOnce();
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(response.mock.calls[0]?.[2]).toMatchObject({
        message: "Session workspace changed during file access",
      });
    });
  });

  it("allows inspecting canonical files when the managed workspace has a preserved conflict", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir } = await seedRegisteredWorktreeConflictSession(
        state.workspaceDir,
      );
      const { withLocalWorkspaceStore } =
        await import("../worker-environments/local-workspace-store.js");
      const { localWorkspaceProjectionFixture } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      await withLocalWorkspaceStore({ worktreeId: entry.worktree.id }, async (store) => {
        await store.create({
          ...localWorkspaceProjectionFixture(entry.worktree.id, state.workspaceDir),
          session_key: key,
          session_id: entry.sessionId,
          projection_path: projectionDir,
          pending_ref: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          pending_target: "canonical",
          checkpoint_json: JSON.stringify({
            conflicts: { "preview.html": {} },
          }),
        });
      });
      const response = await dispatch("sessions.files.get", "preview.html");
      expect(successful(response)).toMatchObject({ file: { content: preview } });
    });
  });

  it("acknowledges and saves a reconciled version via sessions.files.set during conflict", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir, owner, worktreeDir } =
        await seedPreparedWorktreeConflictSession(state.workspaceDir);
      const guestText = "<h1>guest draft</h1>\n";
      const guestHash = createHash("sha256").update(guestText).digest("hex");
      fs.writeFileSync(path.join(projectionDir, "preview.html"), guestText);
      fs.writeFileSync(path.join(worktreeDir, "preview.html"), preview);
      const { withLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-projection.js");
      try {
        await withLocalWorkspaceProjection(owner as any, (s) => s.synchronize("canonical"));
      } catch {
        // expected conflict
      }
      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const source = {
        workspaceId: entry.worktree.id,
        root: entry.spawnedCwd,
        fileRoot: entry.spawnedCwd,
      };
      const result = await invoke("sessions.files.set", {
        sessionKey: key,
        path: "preview.html",
        content: "reconciled administrator content\n",
        expectedHash: guestHash,
        expectedSource: source,
      });
      expect(result).toMatchObject([{ ok: true }]);
      expect(readPreview(entry.spawnedCwd)).toBe("reconciled administrator content\n");
      expect(readPreview(projectionDir)).toBe("reconciled administrator content\n");

      const { readLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      const row = await readLocalWorkspaceProjection(entry.worktree.id);
      expect(row?.pending_ref).toBeNull();
    });
  });

  it("saves a reconciled version when expectedHash matches the inspected guest draft in projection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir } = await seedRegisteredWorktreeConflictSession(
        state.workspaceDir,
      );
      const { withLocalWorkspaceStore } =
        await import("../worker-environments/local-workspace-store.js");
      const { localWorkspaceProjectionFixture, readLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      fs.mkdirSync(projectionDir, { recursive: true });
      const guestDraft = "<h1>guest draft content</h1>\n";
      const guestHash = createHash("sha256").update(guestDraft).digest("hex");
      fs.writeFileSync(file(projectionDir), guestDraft);

      await withLocalWorkspaceStore({ worktreeId: entry.worktree.id }, async (store) => {
        await store.create({
          ...localWorkspaceProjectionFixture(entry.worktree.id, state.workspaceDir),
          session_key: key,
          session_id: entry.sessionId,
          projection_path: projectionDir,
          pending_ref: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          pending_target: "canonical",
          checkpoint_json: JSON.stringify({
            conflicts: { "preview.html": { sha256: guestHash, mode: 0o644 } },
          }),
        });
      });
      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const source = {
        workspaceId: entry.worktree.id,
        root: entry.spawnedCwd,
        fileRoot: entry.spawnedCwd,
      };
      const result = await invoke("sessions.files.set", {
        sessionKey: key,
        path: "preview.html",
        content: "merged human and guest contribution\n",
        expectedHash: guestHash,
        expectedSource: source,
      });
      expect(result).toMatchObject([{ ok: true }]);
      expect(readPreview(entry.spawnedCwd)).toBe("merged human and guest contribution\n");

      const row = await readLocalWorkspaceProjection(entry.worktree.id);
      expect(row?.checkpoint_json).toBeTruthy();
      const checkpoint = JSON.parse(row!.checkpoint_json!);
      expect(checkpoint.acknowledgedPaths).toContain("preview.html");
      expect(checkpoint.acknowledgedGuestVersions?.["preview.html"]).toMatchObject({
        sha256: guestHash,
      });
    });
  });

  it("preserves compare-and-swap protection for unseen canonical edits outside retained conflicts", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir } = await seedRegisteredWorktreeConflictSession(
        state.workspaceDir,
      );
      const { withLocalWorkspaceStore } =
        await import("../worker-environments/local-workspace-store.js");
      const { localWorkspaceProjectionFixture } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      fs.mkdirSync(projectionDir, { recursive: true });
      fs.writeFileSync(file(projectionDir), preview);

      await withLocalWorkspaceStore({ worktreeId: entry.worktree.id }, async (store) => {
        await store.create({
          ...localWorkspaceProjectionFixture(entry.worktree.id, state.workspaceDir),
          session_key: key,
          session_id: entry.sessionId,
          projection_path: projectionDir,
          checkpoint_json: JSON.stringify({ conflicts: {} }),
        });
      });

      fs.writeFileSync(file(entry.spawnedCwd), "<h1>unseen canonical B</h1>\n");

      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const source = {
        workspaceId: entry.worktree.id,
        root: entry.spawnedCwd,
        fileRoot: entry.spawnedCwd,
      };
      const result = await invoke("sessions.files.set", {
        sessionKey: key,
        path: "preview.html",
        content: "<h1>draft C</h1>\n",
        expectedHash,
        expectedSource: source,
      });
      expect(result).toMatchObject([
        {
          ok: false,
          error: expect.objectContaining({
            details: expect.objectContaining({ type: "session_file_conflict" }),
          }),
        },
      ]);
      expect(readPreview(entry.spawnedCwd)).toBe("<h1>unseen canonical B</h1>\n");
    });
  });

  it("accepts a newer guest version that the operator actually reviewed in projection", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir } = await seedRegisteredWorktreeConflictSession(
        state.workspaceDir,
      );
      const { withLocalWorkspaceStore } =
        await import("../worker-environments/local-workspace-store.js");
      const { localWorkspaceProjectionFixture, readLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      const v1Draft = "<h1>guest v1 original conflict</h1>\n";
      const v1Hash = createHash("sha256").update(v1Draft).digest("hex");
      const v2Draft = "<h1>guest v2 newer reviewed</h1>\n";
      const v2Hash = createHash("sha256").update(v2Draft).digest("hex");
      fs.mkdirSync(projectionDir, { recursive: true });
      fs.writeFileSync(file(projectionDir), v2Draft);

      await withLocalWorkspaceStore({ worktreeId: entry.worktree.id }, async (store) => {
        await store.create({
          ...localWorkspaceProjectionFixture(entry.worktree.id, state.workspaceDir),
          session_key: key,
          session_id: entry.sessionId,
          projection_path: projectionDir,
          pending_ref: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          pending_target: "canonical",
          checkpoint_json: JSON.stringify({
            conflicts: { "preview.html": { sha256: v1Hash, mode: 0o644 } },
          }),
        });
      });
      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const source = {
        workspaceId: entry.worktree.id,
        root: entry.spawnedCwd,
        fileRoot: entry.spawnedCwd,
      };
      const result = await invoke("sessions.files.set", {
        sessionKey: key,
        path: "preview.html",
        content: "merged human and newer guest v2\n",
        expectedHash: v2Hash,
        expectedSource: source,
      });
      expect(result).toMatchObject([{ ok: true }]);
      expect(readPreview(entry.spawnedCwd)).toBe("merged human and newer guest v2\n");

      const row = await readLocalWorkspaceProjection(entry.worktree.id);
      expect(row?.checkpoint_json).toBeTruthy();
      const checkpoint = JSON.parse(row!.checkpoint_json!);
      expect(checkpoint.acknowledgedPaths).toContain("preview.html");
      expect(checkpoint.acknowledgedGuestVersions?.["preview.html"]).toMatchObject({
        sha256: v2Hash,
      });
    });
  });

  it("resolves canonical workspace-relative path when saving absolute path candidates", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir } = await seedRegisteredWorktreeConflictSession(
        state.workspaceDir,
      );
      const { withLocalWorkspaceStore } =
        await import("../worker-environments/local-workspace-store.js");
      const { localWorkspaceProjectionFixture, readLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      fs.mkdirSync(projectionDir, { recursive: true });
      const guestDraft = "<h1>guest draft content</h1>\n";
      const guestHash = createHash("sha256").update(guestDraft).digest("hex");
      fs.writeFileSync(file(projectionDir), guestDraft);

      await withLocalWorkspaceStore({ worktreeId: entry.worktree.id }, async (store) => {
        await store.create({
          ...localWorkspaceProjectionFixture(entry.worktree.id, state.workspaceDir),
          session_key: key,
          session_id: entry.sessionId,
          projection_path: projectionDir,
          pending_ref: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          pending_target: "canonical",
          checkpoint_json: JSON.stringify({
            conflicts: { "preview.html": { sha256: guestHash, mode: 0o644 } },
          }),
        });
      });
      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const source = {
        workspaceId: entry.worktree.id,
        root: entry.spawnedCwd,
        fileRoot: entry.spawnedCwd,
      };
      const absoluteCandidate = file(entry.spawnedCwd);
      const result = await invoke("sessions.files.set", {
        sessionKey: key,
        path: absoluteCandidate,
        content: "merged via absolute path\n",
        expectedHash: guestHash,
        expectedSource: source,
      });
      expect(result).toMatchObject([{ ok: true }]);
      expect(readPreview(entry.spawnedCwd)).toBe("merged via absolute path\n");

      const row = await readLocalWorkspaceProjection(entry.worktree.id);
      expect(row?.checkpoint_json).toBeTruthy();
      const checkpoint = JSON.parse(row!.checkpoint_json!);
      expect(checkpoint.acknowledgedPaths).toContain("preview.html");
    });
  });

  it("resolves conflict hash correctly when session has a nested fileRoot", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { entry, projectionDir, owner, worktreeDir } =
        await seedPreparedWorktreeConflictSession(state.workspaceDir, {
          subDir: "sub",
          initialFile: "sub/handover.md",
          initialContent: "base handover\n",
        });
      const subCanonical = path.join(worktreeDir, "sub", "handover.md");
      const subProjection = path.join(projectionDir, "sub", "handover.md");
      fs.writeFileSync(subCanonical, "canonical handover\n");
      fs.writeFileSync(subProjection, "guest handover draft\n");
      const guestHash = createHash("sha256").update("guest handover draft\n").digest("hex");

      const { withLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-projection.js");
      try {
        await withLocalWorkspaceProjection(owner as any, (projectionState) =>
          projectionState.synchronize("canonical"),
        );
      } catch {
        // expected conflict
      }

      const invoke = createSessionFilesHandlerInvoker(sessionsFilesHandlers);
      const source = {
        workspaceId: entry.worktree.id,
        root: worktreeDir,
        fileRoot: path.join(worktreeDir, "sub"),
      };
      const result = await invoke("sessions.files.set", {
        sessionKey: key,
        path: "sub/handover.md",
        content: "reconciled handover content\n",
        expectedHash: guestHash,
        expectedSource: source,
      });
      expect(result).toMatchObject([{ ok: true }]);
      expect(fs.readFileSync(subCanonical, "utf8")).toBe("reconciled handover content\n");
      expect(fs.readFileSync(subProjection, "utf8")).toBe("reconciled handover content\n");

      const { readLocalWorkspaceProjection } =
        await import("../worker-environments/local-workspace-store.test-support.js");
      const row = await readLocalWorkspaceProjection(entry.worktree.id);
      expect(row?.pending_ref).toBeNull();
    });
  });
});
