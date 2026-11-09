// Register shared transport mocks before publication owners load.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  root,
  commandResult,
  overrideCommands,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { createHostWorkspaceEditTool } from "../agents/agent-tools.read.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { deleteRegistryWorktree } from "../agents/worktrees/registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-entry-children-read.js";
import { withSessionStoreReaderInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";
import { readPublicationCommit } from "./github-publication-git.test-support.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
} from "./github-publication-requester.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { createGatewaySession } from "./session-create-service.js";
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";
import * as allocation from "./session-worktree-preparation.js";

const mocks = githubPublicationTestMocks();
const createFixture = () =>
  createRequesterPublicationFixture(vi.fn(), "local", {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });

async function useRealSessionReads() {
  const actual = await vi.importActual<typeof import("./session-utils-store-worker.js")>(
    "./session-utils-store-worker.js",
  );
  const store = await import("./session-utils-store-worker.js");
  const read = vi
    .spyOn(store, "loadGatewaySessionEntryReadOnlyInWorker")
    .mockImplementation(actual.loadGatewaySessionEntryReadOnlyInWorker);
  onTestFinished(() => read.mockRestore());
}

async function worktreeState(
  workspace: NonNullable<Awaited<ReturnType<typeof createFixture>>["local"]>,
) {
  return {
    head: await workspace.git("rev-parse", "HEAD"),
    index: await fs.readFile(path.join(workspace.cwd, ".git/index")),
    diff: await workspace.git("diff", "HEAD"),
  };
}

const LOCAL_CHECKOUT_OUTCOMES = [
  "published",
  "project",
  "private project",
  "writer project",
  "system private project",
  "foreign project",
  "linked project worktree",
  "before binding",
  "before push",
  "before PR",
] as const;

describe("local checkout publication", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    realWorktree: true,
  });
  it("publishes an owned checkout outside the default workspace without admin", async () => {
    const f = await createFixture();
    await useRealSessionReads();
    const source = f.local!;
    const workspace = path.join(root, "default-workspace");
    await fs.mkdir(workspace);
    const alias = path.join(workspace, "owned-checkout");
    await fs.symlink(source.cwd, alias, "junction");
    setRuntimeConfigSnapshot({
      ...f.config,
      agents: { entries: { main: { workspace } } },
    });
    const invoke = async (workspacePath: string, handoff = true) => {
      const respond = vi.fn();
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION_KEY,
          ...(handoff ? { workspacePrAdoptionSessionId: SESSION_ID } : {}),
        },
        () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: "owned-checkout",
              method: "sessions.github.publish",
              params: { sessionKey: SESSION_KEY, idempotencyKey: "owned-checkout", workspacePath },
            },
            context: {
              ...createDirectChatContext({ getRuntimeConfig }),
              workerSessionPlacementService: f.placements,
              githubPublicationService: f.coordinator,
            },
            client: f.guestSource.client,
            isWebchatConnect: () => false,
            respond,
          }),
      );
      return respond.mock.calls[0];
    };
    const before = await worktreeState(source);
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    const worktree = loadSessionEntryReadOnly(scope)!.worktree;
    await upsertSessionEntryCore(scope, { worktree: undefined });
    expect(await invoke(source.cwd)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("operator.admin") },
    ]);
    await upsertSessionEntryCore(scope, { worktree });
    expect(await worktreeState(source)).toEqual(before);
    expect(source.effects).toEqual([]);
    expect(f.guestSource.client.connect.scopes).not.toContain("operator.admin");
    expect(await invoke(source.cwd, false)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("agent handoff") },
    ]);
    for (const [other, message] of [
      [workspace, "not a git repository"],
      [root, "operator.admin"],
      [path.join(source.cwd, ".git"), "operator.admin"],
      ["repository", "cwd must be absolute"],
    ] as const) {
      expect(await invoke(other)).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining(message) },
      ]);
      expect(await worktreeState(source)).toEqual(before);
      expect(source.effects).toEqual([]);
    }
    const result = await invoke(source.cwd);
    expect(result).toMatchObject([
      true,
      { status: "published", url: expect.stringContaining("/pull/") },
    ]);
    expect(source.effects).toEqual(["push", "pull_request"]);
    expect(await invoke(alias)).toEqual(result);
    expect(await invoke(`${source.cwd}/.`)).toEqual(result);
    expect(source.effects).toEqual(["push", "pull_request"]);
    await f.revoke();
    expect(await invoke(source.cwd)).toMatchObject([false, undefined, expect.anything()]);
    expect(source.effects).toEqual(["push", "pull_request"]);
  });

  it("keeps private publication session rows in memory and reuses its accepted checkout", async () => {
    const f = await createFixture();
    await useRealSessionReads();
    const source = f.local!;
    setRuntimeConfigSnapshot({
      ...f.config,
      agents: { entries: { main: { workspace: root } } },
    });
    const actual = await vi.importActual<typeof import("../agents/worktrees/service.js")>(
      "../agents/worktrees/service.js",
    );
    const registry = await vi.importActual<typeof import("../agents/worktrees/registry-read.js")>(
      "../agents/worktrees/registry-read.js",
    );
    mocks.resolveRepository.mockImplementation(
      actual.managedWorktrees.resolveRepositoryIdentity.bind(actual.managedWorktrees),
    );
    mocks.readWorktree.mockImplementation(registry.readLiveRegistryWorktreeByOwner);
    await source.git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    await source.git("add", "artifact.txt");
    await source.git("commit", "-m", "Implement private task");
    const location = {
      agentId: "main",
      path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    onTestFinished(() => memorySessionActorOwners.closeDatabase(location));
    const created = await createGatewaySession({
      cfg: getRuntimeConfig(),
      agentId: "main",
      incognito: true,
      requestingOperatorScopes: ["operator.admin"],
      operatorRoleActor: { kind: "system" },
      creation: { via: "operator", actor: { type: "system" } },
      commandSource: "test",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      throw new Error(created.error.message);
    }
    const scope = { agentId: "main", sessionKey: created.key };
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: ["operator.admin"],
    });
    const context = {
      ...createDirectChatContext({ getRuntimeConfig }),
      workerSessionPlacementService: f.placements,
      githubPublicationService: f.coordinator,
    };
    const invoke = async () => {
      const respond = vi.fn();
      await withGatewayToolCallerIdentity(
        { ...scope, workspacePrAdoptionSessionId: created.entry.sessionId },
        () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: "private-publication",
              method: "sessions.github.publish",
              params: {
                ...scope,
                workspacePath: source.cwd,
                idempotencyKey: "private-publication",
              },
            },
            context,
            client,
            isWebchatConnect: () => false,
            respond,
          }),
      );
      return respond.mock.calls[0];
    };
    const result = await invoke();
    expect(result).toMatchObject([true, { status: "published" }]);
    expect(await invoke()).toEqual(result);
    const children = await listSessionChildEntriesReadOnly(scope);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      sessionKey: expect.stringMatching(/^agent:main:dashboard:incognito-/u),
      entry: {
        incognito: true,
        parentSessionKey: created.key,
        worktree: { canonicalWorkspaceDir: source.cwd },
      },
    });
    const durable = await withSessionStoreReaderInWorker(
      { agentId: "main", storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }) },
      ({ reader, database, continuation }) =>
        reader.readExactEntries({
          sessionKeys: [created.key, children[0]!.sessionKey],
          env: database.env,
          continuation,
        }),
      { backing: true, dataOnly: true },
    );
    expect(durable.entries).toEqual([]);
    expect(loadSessionEntryReadOnly(scope)?.worktree).toBeUndefined();
    expect(source.effects).toEqual(["push", "pull_request"]);
  });

  it.each(LOCAL_CHECKOUT_OUTCOMES)("local checkout outcome: %s", async (outcome) => {
    const f = await createFixture();
    await useRealSessionReads();
    const source = f.local!;
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    setRuntimeConfigSnapshot({
      ...f.config,
      agents: { entries: { main: { workspace: root } } },
    });
    await deleteRegistryWorktree(process.env, loadSessionEntryReadOnly(scope)!.worktree!.id);
    await upsertSessionEntryCore(scope, {
      worktree: undefined,
      sessionRoot: root,
      spawnedCwd: root,
      spawnedWorkspaceDir: root,
      spawnedBy: "agent:main:parent",
      thinkingLevel: "high",
      label: "Existing task",
      inheritedToolAllow: ["github_publish", "read"],
      inheritedToolDeny: ["exec"],
      permissionMode: "guarded",
    });
    const actual = await vi.importActual<typeof import("../agents/worktrees/service.js")>(
      "../agents/worktrees/service.js",
    );
    const registry = await vi.importActual<typeof import("../agents/worktrees/registry-read.js")>(
      "../agents/worktrees/registry-read.js",
    );
    mocks.resolveRepository.mockImplementation(
      actual.managedWorktrees.resolveRepositoryIdentity.bind(actual.managedWorktrees),
    );
    mocks.readWorktree.mockImplementation(registry.readLiveRegistryWorktreeByOwner);
    await source.git("remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
    const manager = await SessionManager.openAsync(
      {
        ...scope,
        sessionId: SESSION_ID,
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      },
      source.cwd,
    );
    await manager.appendMessageAsync(
      makeUserMessage("Implement this change and publish its PR", 1),
    );
    const requester = outcome === "writer project" ? f.maintainerSource : f.guestSource;
    const requesterClient =
      outcome === "system private project"
        ? createSyntheticPluginRuntimeClient({
            operatorRoleActor: { kind: "system" },
            scopes: guestScopes,
          })
        : requester.client;
    const clients = [requester.client, f.maintainerSource.client];
    const context = {
      ...createDirectChatContext({
        getRuntimeConfig,
        getClientConnIds: (filter) =>
          new Set(
            clients.filter((client) => !filter || filter(client)).map((client) => client.connId),
          ),
      }),
      workerSessionPlacementService: f.placements,
      githubPublicationService: f.coordinator,
    };
    const invoke = async (
      handoff = true,
      workspacePath = source.cwd,
      idempotencyKey = "local-checkout",
      runId = "initial-publication-run",
    ) => {
      const respond = vi.fn();
      const params = {
        sessionKey: SESSION_KEY,
        idempotencyKey,
        workspacePath,
      };
      await withGatewayToolCallerIdentity(
        {
          ...scope,
          ...(handoff ? { workspacePrAdoptionSessionId: SESSION_ID } : {}),
          workspacePublicationRunId: runId,
        },
        () =>
          handleGatewayRequest({
            req: {
              type: "req",
              id: params.idempotencyKey,
              method: "sessions.github.publish",
              params,
            },
            context,
            client: requesterClient,
            isWebchatConnect: () => false,
            respond,
          }),
      );
      const response = respond.mock.calls[0];
      if (!response) {
        throw new Error("Local publication did not produce a Gateway response.");
      }
      return response;
    };
    const dirty = await worktreeState(source);
    expect(await invoke(false)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("agent handoff") },
    ]);
    expect(await invoke()).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("Commit the task changes") },
    ]);
    expect(await worktreeState(source)).toEqual(dirty);
    await source.git("add", "artifact.txt");
    await source.git("commit", "-m", "Implement the requested change");
    const linked = path.join(root, "linked-worktree");
    if (outcome === "linked project worktree") {
      await source.git("worktree", "add", "-q", "--detach", linked, "HEAD");
    }
    let projectId: string | undefined;
    let projectVisibility =
      outcome.includes("private") || outcome === "writer project" ? "private" : "public";
    if (outcome.includes("project")) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (input) => {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          expect(new URL(url).pathname).toBe("/repos/openclaw/openclaw");
          return Response.json({ visibility: projectVisibility });
        }),
      );
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      let projectRoot = source.cwd;
      if (outcome === "foreign project") {
        projectRoot = path.join(root, "other-repository");
        await source.git("init", "-q", projectRoot);
        await source.git("-C", projectRoot, "commit", "-q", "--allow-empty", "-m", "init");
        await source.git(
          "-C",
          projectRoot,
          "remote",
          "add",
          "origin",
          "https://github.com/openclaw/openclaw.git",
        );
      }
      projectId = (await registerProjectRegistry({ path: projectRoot })).id;
      await upsertSessionEntryCore(scope, { projectId });
    }
    const before = await worktreeState(source);
    if (outcome === "linked project worktree") {
      const update = mocks.updateIndex.getMockImplementation()!;
      mocks.updateIndex.mockImplementationOnce(async (...args) => {
        await fs.writeFile(path.join(linked, "artifact.txt"), "another chat\n");
        await source.git("-C", linked, "checkout", "-q", "-b", "another-chat");
        await source.git("-C", linked, "commit", "-q", "-am", "Another chat's change");
        return await update(...args);
      });
    }
    if (outcome === "before binding") {
      const prepare = allocation.prepareSessionWorktree;
      const spy = vi
        .spyOn(allocation, "prepareSessionWorktree")
        .mockImplementationOnce(async (...args) => {
          const allocated = await prepare(...args);
          await f.revoke();
          return allocated;
        });
      onTestFinished(() => spy.mockRestore());
    } else if (outcome === "before push") {
      const update = mocks.updateIndex.getMockImplementation()!;
      mocks.updateIndex.mockImplementationOnce(async (...args) => {
        const result = await update(...args);
        await f.revoke();
        return result;
      });
    } else if (outcome === "before PR") {
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (...args) => {
        const result = await transport(...args);
        if (args[0].includes("push")) {
          await f.revoke();
        }
        return result;
      });
    }
    const publicationSource = outcome === "linked project worktree" ? linked : source.cwd;
    const result = await invoke(true, publicationSource);
    expect(await worktreeState(source)).toEqual(before);
    // Publishing a task must not redirect the next turn's editor or shell.
    expect(loadSessionEntryReadOnly(scope)?.spawnedCwd).toBe(root);
    expect(loadSessionEntryReadOnly(scope)?.worktree).toBeUndefined();
    if (outcome === "foreign project") {
      expect(result).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining("different repository") },
      ]);
      expect(await listSessionChildEntriesReadOnly(scope)).toEqual([]);
      expect(source.effects).toEqual([]);
      return;
    }
    if (outcome.includes("private")) {
      expect(result).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining("project is unavailable to this requester") },
      ]);
      expect(await listSessionChildEntriesReadOnly(scope)).toEqual([]);
      expect(source.effects).toEqual([]);
      return;
    }
    if (outcome.startsWith("before")) {
      expect(result).toMatchObject([
        false,
        undefined,
        { code: "UNAVAILABLE", message: expect.stringContaining("no longer authorized") },
      ]);
      expect(source.effects).toEqual(outcome === "before PR" ? ["push"] : []);
      if (outcome === "before binding") {
        expect(loadSessionEntryReadOnly(scope)?.worktree).toBeUndefined();
      }
      return;
    }
    expect(result).toMatchObject([
      true,
      { status: "published", url: expect.stringContaining("/pull/") },
    ]);
    const parent = loadSessionEntryReadOnly(scope)!;
    expect(parent).toMatchObject({
      thinkingLevel: "high",
      label: "Existing task",
    });
    const resumedRoot = resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: parent.spawnedBy,
      workspaceDir: parent.spawnedWorkspaceDir,
      cwd: parent.spawnedCwd,
    });
    expect(resumedRoot).toBe(root);
    expect(resolveSessionWorkspaceRoots(getRuntimeConfig(), "main", parent).root).toBe(resumedRoot);
    const children = await listSessionChildEntriesReadOnly(scope);
    expect(children).toHaveLength(1);
    const task = children[0]!;
    expect(parent.projectId).toBe(projectId);
    expect(task.entry.projectId).toBe(projectId);
    expect(task.entry).toMatchObject({
      parentSessionKey: SESSION_KEY,
      parentSessionId: SESSION_ID,
      worktree: { canonicalWorkspaceDir: publicationSource },
      inheritedToolAllow: ["github_publish", "read"],
      inheritedToolDeny: ["exec"],
      permissionMode: "guarded",
    });
    expect(await fs.readFile(path.join(task.entry.spawnedCwd!, "artifact.txt"), "utf8")).toBe(
      "accepted\n",
    );
    expect(await worktreeState(source)).toEqual(before);
    expect(source.effects).toEqual(["push", "pull_request"]);
    expect(
      await invoke(true, publicationSource, "local-checkout", "retry-publication-run"),
    ).toEqual(result);
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);
    expect(await worktreeState(source)).toEqual(before);
    expect(source.effects).toEqual(["push", "pull_request"]);
    context.githubPublicationService = f.restart();
    expect(await context.githubPublicationService.listUnreportedResultsAsync()).toContainEqual(
      expect.objectContaining({
        origin: expect.objectContaining({
          ...scope,
          sessionId: SESSION_ID,
          runId: "initial-publication-run",
        }),
      }),
    );
    const status = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "parent-status",
        method: "sessions.github.status",
        params: { ...scope, requestId: result[1].requestId },
      },
      context,
      client: requester.client,
      isWebchatConnect: () => false,
      respond: status,
    });
    expect(status.mock.calls[0]).toMatchObject([true, { result: result[1] }]);
    const replay = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "parent-retry",
        method: "sessions.github.publish",
        params: { ...scope, idempotencyKey: "local-checkout" },
      },
      context,
      client: requester.client,
      isWebchatConnect: () => false,
      respond: replay,
    });
    expect(replay.mock.calls[0]).toEqual(result);
    expect(source.effects).toEqual(["push", "pull_request"]);
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);

    if (projectId) {
      if (outcome === "linked project worktree") {
        expect(await fs.readFile(path.join(linked, "artifact.txt"), "utf8")).toBe("another chat\n");
      }
      if (outcome === "project") {
        projectVisibility = "private";
        expect(await invoke(true, publicationSource)).toEqual(result);
        expect(await invoke(true, publicationSource, "new-project-task")).toMatchObject([
          false,
          undefined,
          { message: expect.stringContaining("project is unavailable to this requester") },
        ]);
        expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);
        expect(source.effects).toEqual(["push", "pull_request"]);
      }
      return;
    }

    // A later task can edit and publish another repository from the same conversation.
    const other = path.join(root, "another-repository");
    await source.git("clone", "--no-local", source.cwd, other);
    await source.git(
      "-C",
      other,
      "remote",
      "set-url",
      "origin",
      "https://github.com/openclaw/openclaw.git",
    );
    const edit = createHostWorkspaceEditTool(resumedRoot!, { workspaceOnly: true });
    await edit.execute("next-task", {
      path: path.join(other, "artifact.txt"),
      edits: [{ oldText: "accepted\n", newText: "second task\n" }],
    });
    await source.git("-C", other, "add", "artifact.txt");
    await source.git("-C", other, "commit", "-m", "Implement the next task");
    overrideCommands(async (argv) => {
      const commit = argv
        .find((arg) => arg.startsWith("repos/openclaw/openclaw/git/commits/"))
        ?.split("/")
        .at(-1);
      return commit
        ? commandResult(
            JSON.stringify(
              await readPublicationCommit((...args) => source.git("-C", other, ...args), commit),
            ),
          )
        : undefined;
    });
    const nextPublication = await invoke(true, other, "another-checkout");
    expect(nextPublication, JSON.stringify(nextPublication)).toMatchObject([
      true,
      { status: "published" },
    ]);
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(2);
    expect(loadSessionEntryReadOnly(scope)?.spawnedCwd).toBe(root);
    expect(await worktreeState(source)).toEqual(before);

    // Deleting the source task must not turn the parent's original retry into a new publication.
    const deleted = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "delete-source-task",
        method: "sessions.delete",
        params: { key: task.sessionKey },
      },
      context,
      client: f.maintainerSource.client,
      isWebchatConnect: () => false,
      respond: deleted,
    });
    expect(deleted.mock.calls[0]).toMatchObject([true, { deleted: true }, undefined]);
    expect(
      loadSessionEntryReadOnly({ agentId: "main", sessionKey: task.sessionKey }),
    ).toBeUndefined();
    const effects = [...source.effects];
    expect(await invoke()).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("original publication task is unavailable") },
    ]);
    const retainedStatus = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "deleted-task-status",
        method: "sessions.github.status",
        params: { ...scope, requestId: result[1].requestId },
      },
      context,
      client: requester.client,
      isWebchatConnect: () => false,
      respond: retainedStatus,
    });
    expect(retainedStatus.mock.calls[0]).toMatchObject([true, { result: result[1] }]);
    expect(source.effects).toEqual(effects);
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);
  });
});

describe("registered session GitHub publication access", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([
    { target: "own", policy: "absent", actor: "guest", outcome: "published" },
    { target: "foreign", policy: "view", actor: "guest", outcome: "INVALID_REQUEST" },
    { target: "foreign", policy: "absent", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "foreign", policy: "write", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "member", policy: "write", actor: "guest", outcome: "UNAVAILABLE" },
    { target: "missing", policy: "absent", actor: "guest", outcome: "INVALID_REQUEST" },
    { target: "foreign", policy: "write", actor: "staff", outcome: "published" },
    { target: "foreign", policy: "absent", actor: "system", outcome: "published" },
    { target: "own", policy: "write", actor: "mixed", outcome: "published" },
    { target: "member", policy: "write", actor: "mixed", outcome: "UNAVAILABLE" },
  ] as const)(
    "checks $target target for $actor with role policy=$policy",
    async ({ target, policy, actor, outcome }) => {
      const f = await createFixture();
      if (!f.local) {
        throw new Error("Expected a local publication fixture.");
      }
      const workspace = f.local;
      const gateway = f.config.gateway!;
      const roles = gateway.roles!;
      const requestScopes: OperatorScope[] =
        actor === "mixed" ? ["operator.read", "operator.approvals", ...guestScopes] : guestScopes;
      setRuntimeConfigSnapshot({
        ...f.config,
        gateway: {
          ...gateway,
          roles:
            policy === "absent"
              ? undefined
              : {
                  ...roles,
                  definitions: {
                    ...roles.definitions,
                    guest: {
                      ...roles.definitions.guest!,
                      scopes: requestScopes,
                      sessions: { others: policy },
                    },
                  },
                },
        },
      });
      const profileId =
        actor === "staff"
          ? f.maintainerProfile
          : target === "own"
            ? f.guestProfile
            : (await ensureCanonicalUserProfileForEmail("publication-foreign@example.test")).id;
      const person = createOperatorWsClient({
        connId: profileId,
        scopes: actor === "staff" ? ["operator.write"] : requestScopes,
      });
      person.authenticatedUserProfile = {
        profileId,
        displayName: null,
        avatarRevision: "fixture",
        hasAvatar: false,
        updatedAt: 1,
      };
      prepareGatewayConnectOperatorAccess(person);
      if (target === "member") {
        const { inserted } = await addSessionMember(
          { agentId: "main", sessionKey: SESSION_KEY },
          { identityId: profileId, addedBy: f.guestProfile },
        );
        expect(inserted).toBe(true);
      }
      const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
        typeof import("./session-utils-store-worker.js")
      >("./session-utils-store-worker.js");
      mocks.loadSession.mockImplementation((key: string, options?: { agentId?: string }) =>
        loadGatewaySessionEntryReadOnlyInWorker({
          cfg: getRuntimeConfig(),
          key,
          ...options,
          readOnly: true,
        }),
      );
      const request = vi.spyOn(f.coordinator, "requestForSessionV2");
      const before = await worktreeState(workspace);
      const respond = vi.fn();
      const params = {
        sessionKey: target === "missing" ? "agent:main:dashboard:missing" : SESSION_KEY,
        idempotencyKey: `${target}-${policy}-${actor}`,
      };
      await handleGatewayRequest({
        req: { type: "req", id: params.idempotencyKey, method: "sessions.github.publish", params },
        context: {
          ...f.guestSource.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        client:
          actor === "system"
            ? createSyntheticPluginRuntimeClient({
                operatorRoleActor: { kind: "system" },
                scopes: guestScopes,
              })
            : person,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(
        ...(outcome === "published"
          ? [true, expect.objectContaining({ status: "published" })]
          : [false, undefined, expect.objectContaining({ code: outcome })]),
      );
      expect(workspace.effects).toEqual(outcome === "published" ? ["push", "pull_request"] : []);
      if (outcome !== "published") {
        expect(request).not.toHaveBeenCalled();
        expect(await worktreeState(workspace)).toEqual(before);
      }
    },
  );

  it("invalidates publication metadata after committed workspace and lifecycle updates", async () => {
    await createFixture();
    using session = await prepareGitHubPublicationSession(SESSION_KEY, { agentId: "main" });
    const initial = session.loaded.entry!;
    const scope = {
      agentId: "main",
      sessionKey: SESSION_KEY,
      storePath: session.loaded.storePath,
    };
    await upsertSessionEntryCore(scope, { label: "renamed publication" });
    expect(session.readCurrent().entry?.sessionId).toBe(SESSION_ID);
    const worktree = { ...initial.worktree!, branch: "updated-publication-branch" };
    await upsertSessionEntryCore(scope, { worktree });
    expect(() => session.readCurrent()).toThrow("GitHub publication session lifecycle changed.");
    using replacement = await prepareGitHubPublicationSession(SESSION_KEY, { agentId: "main" });
    expect(replacement.readCurrent().entry?.worktree).toEqual(worktree);
    await upsertSessionEntryCore(scope, { lifecycleRevision: "replacement-publication" });
    expect(() => replacement.readCurrent()).toThrow(
      "GitHub publication session lifecycle changed.",
    );
  });
});
