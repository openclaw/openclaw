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
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { createHostWorkspaceEditTool } from "../agents/agent-tools.read.js";
import * as sessionSlugs from "../agents/session-slug.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import * as worktreeGit from "../agents/worktrees/git.js";
import { deleteRegistryWorktree, insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-entry-children-read.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { deriveGitHubPublicationTaskId } from "../state/github-publication-requester.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";
import { readPublicationCommit } from "./github-publication-git.test-support.js";
import { prepareGitHubPublicationTaskRequester } from "./github-publication-requester.js";
import {
  createGitHubPublicationRequesterFixture,
  createLocalPublicationFixture,
  readPublicationWorktreeState,
  useRealSessionReads,
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
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const LOCAL_CHECKOUT_OUTCOMES = [
  "published",
  "previous task",
  "ambiguous previous tasks",
  "rebased task",
  "task access",
  "project",
  "private project",
  "writer project",
  "system private project",
  "foreign project",
  "linked project worktree",
  "unowned managed worktree",
  "before binding",
  "before push",
  "before PR",
] as const;

describe("local checkout publication", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    realWorktree: true,
  });
  beforeEach(async () => {
    onTestFinished((await prepareUserProfileCatalog()).release);
  });
  it("publishes an owned checkout outside the default workspace without admin", async () => {
    const f = await createLocalPublicationFixture();
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
    const before = await readPublicationWorktreeState(source);
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    const worktree = loadSessionEntryReadOnly(scope)!.worktree;
    await upsertSessionEntryCore(scope, { worktree: undefined });
    expect(await invoke(source.cwd)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("operator.admin") },
    ]);
    await upsertSessionEntryCore(scope, { worktree });
    expect(await readPublicationWorktreeState(source)).toEqual(before);
    expect(source.effects).toEqual([]);
    expect(f.guestSource.client.connect.scopes).not.toContain("operator.admin");
    expect(await invoke(source.cwd, false)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("agent handoff") },
    ]);
    for (const [other, message] of [
      [workspace, "not a git repository"],
      // The refusal names the admitted paths; a bare scope gives a tool caller no next step.
      [root, "operator.admin. Without it, workspacePath"],
      [path.join(source.cwd, ".git"), "operator.admin"],
      ["repository", "cwd must be absolute"],
    ] as const) {
      expect(await invoke(other)).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining(message) },
      ]);
      expect(await readPublicationWorktreeState(source)).toEqual(before);
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

  it.each(LOCAL_CHECKOUT_OUTCOMES)("local checkout outcome: %s", async (outcome) => {
    // Separate clones share one remote, so their publication branches must not collide.
    const names = vi
      .spyOn(sessionSlugs, "createCrustaceanSlug")
      .mockReturnValueOnce("first-publication")
      .mockReturnValueOnce("next-publication");
    onTestFinished(() => names.mockRestore());
    const f = await createLocalPublicationFixture();
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
    const requester =
      outcome === "writer project" || outcome === "task access"
        ? f.maintainerSource
        : f.guestSource;
    // Subagent tool calls arrive as a System client capped at operator.write.
    const systemScopes: OperatorScope[] | undefined =
      outcome === "system private project"
        ? guestScopes
        : outcome === "unowned managed worktree"
          ? ["operator.write"]
          : undefined;
    let requesterClient = systemScopes
      ? createSyntheticPluginRuntimeClient({
          operatorRoleActor: { kind: "system" },
          scopes: systemScopes,
        })
      : requester.client;
    const clients = [f.guestSource.client, f.maintainerSource.client];
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
      workspacePath: string | undefined,
      handoff = true,
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
    const dirty = await readPublicationWorktreeState(source);
    expect(await invoke(source.cwd, false)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("agent handoff") },
    ]);
    expect(await invoke(source.cwd)).toMatchObject([
      false,
      undefined,
      { message: expect.stringContaining("Commit the task changes") },
    ]);
    expect(await readPublicationWorktreeState(source)).toEqual(dirty);
    if (outcome === "rebased task") {
      await fs.writeFile(path.join(source.cwd, "shared.txt"), "upstream improvement\n");
      await source.git("add", "shared.txt");
    }
    await source.git("add", "artifact.txt");
    await source.git("commit", "-m", "Implement the requested change");
    const linked = path.join(root, "linked-worktree");
    if (outcome === "linked project worktree") {
      await source.git("worktree", "add", "-q", "--detach", linked, "HEAD");
    }
    let managed: string | undefined;
    if (outcome === "unowned managed worktree") {
      // Managed worktrees live outside every agent workspace, like the configured worktree root.
      const managedRoot = tempDirs.make("openclaw-managed-worktrees-");
      const { fingerprint } = await actual.managedWorktrees.resolveRepositoryIdentity(source.cwd);
      for (const [name, ownerKind] of [
        ["unowned-task", "manual"],
        ["another-chat", "session"],
      ] as const) {
        const checkout = path.join(managedRoot, name);
        await source.git("worktree", "add", "-q", "-b", `openclaw/${name}`, checkout, "HEAD");
        await insertRegistryWorktree(process.env, {
          id: name,
          name,
          repoFingerprint: fingerprint,
          repoRoot: source.cwd,
          path: checkout,
          branch: `openclaw/${name}`,
          baseRef: "main",
          ownerKind,
          ...(ownerKind === "session" ? { ownerId: "agent:main:dashboard:another-chat" } : {}),
          createdAt: Date.now(),
          lastActiveAt: Date.now(),
        });
      }
      managed = path.join(managedRoot, "unowned-task");
      // A session-scoped guest cannot create worktrees, and a session's checkout stays its own.
      const writer = requesterClient;
      for (const [key, client, checkout] of [
        ["guest-managed-worktree", f.guestSource.client, managed],
        ["session-owned-worktree", writer, path.join(managedRoot, "another-chat")],
      ] as const) {
        requesterClient = client;
        expect(await invoke(checkout, true, key)).toMatchObject([
          false,
          undefined,
          { message: expect.stringContaining("operator.admin") },
        ]);
      }
      requesterClient = writer;
      expect(source.effects).toEqual([]);
      expect(await listSessionChildEntriesReadOnly(scope)).toEqual([]);
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
    let before = await readPublicationWorktreeState(source);
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
    const publicationSource =
      managed ?? (outcome === "linked project worktree" ? linked : source.cwd);
    if (outcome === "published") {
      expect(await invoke(undefined)).toMatchObject([
        false,
        undefined,
        {
          message: expect.stringContaining(
            "call github_publish with workspacePath set to the checkout's absolute path",
          ),
        },
      ]);
      expect(source.effects).toEqual([]);
      expect(await listSessionChildEntriesReadOnly(scope)).toEqual([]);
    }
    const previousPublications: Array<{ url?: string; branch?: string }> = [];
    if (outcome === "previous task" || outcome === "ambiguous previous tasks") {
      const original = await createGitHubPublicationRequesterFixture({
        ...scope,
        profileId: f.guestProfile,
        scopes: guestScopes,
      });
      const origin = {
        ...scope,
        sessionId: SESSION_ID,
        lifecycleRevision: loadSessionEntryReadOnly(scope)!.lifecycleRevision ?? null,
      };
      // Create the previous version's task shape through real creation and publication
      // owners; accepted receipts must be written by the coordinator, never seeded.
      for (let index = 0; index < (outcome === "previous task" ? 1 : 2); index++) {
        const idempotencyKey = `previous-publication-${index}`;
        const taskId = deriveGitHubPublicationTaskId(origin, idempotencyKey);
        const created = await createGatewaySession({
          cfg: getRuntimeConfig(),
          agentId: "main",
          key: `agent:main:dashboard:github-${taskId}`,
          parentSessionKey: SESSION_KEY,
          label: `github-publication-${taskId}`,
          requestingOperatorScopes: guestScopes,
          requestingOperatorProfileId: f.guestProfile,
          operatorRoleActor: original.requester.snapshot.actor,
          creation: {
            via: "spawn",
            actor: {
              type: "agent",
              id: "main",
              delegatedBy: { type: "human", source: "profile", id: f.guestProfile },
            },
            requesterProfileId: f.guestProfile,
          },
          commandSource: "github-publication",
          spawnDepth: 1,
          spawnToolPolicy: { version: 1, allow: ["github_publish", "read"], deny: ["exec"] },
          preparedPermissionSelection: {
            mode: "guarded",
            assertCurrent: original.requester.assertCurrent,
          },
          prepareLifecycle: async (target) =>
            allocation.prepareSessionWorktree({
              cfg: getRuntimeConfig(),
              target,
              workspace: source.cwd,
              checkoutCommit: await source.git("rev-parse", "HEAD"),
              runSetupScript: false,
            }),
        });
        if (!created.ok) {
          throw new Error(created.error.message);
        }
        const transferred = await prepareGitHubPublicationTaskRequester(
          original.requester,
          { agentId: "main", sessionKey: created.key },
          origin,
          getRuntimeConfig,
        );
        onTestFinished(transferred.release);
        const published = await f.coordinator.requestForSessionV2({
          agentId: "main",
          sessionKey: created.key,
          idempotencyKey,
          requester: transferred.requester,
        });
        if (published.status !== "published") {
          throw new Error(`Previous publication did not complete: ${published.status}`);
        }
        previousPublications.push(published);
      }
      context.githubPublicationService = f.restart();
      if (outcome === "ambiguous previous tasks") {
        const effects = [...source.effects];
        expect(await invoke(source.cwd)).toMatchObject([
          false,
          undefined,
          { message: expect.stringContaining("Multiple publication tasks") },
        ]);
        expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(2);
        expect(source.effects).toEqual(effects);
        expect(await readPublicationWorktreeState(source)).toEqual(before);
        return;
      }
      expect(await invoke(source.cwd, true, "previous-publication-0")).toMatchObject([
        true,
        { status: "published", ...previousPublications[0] },
      ]);
    }
    const result = await invoke(publicationSource);
    if (previousPublications.length) {
      const { url, branch } = previousPublications[0]!;
      expect(result).toMatchObject([true, { url, branch }]);
    }
    expect(await readPublicationWorktreeState(source)).toEqual(before);
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
    const publicationTarget = { url: result[1].url, branch: result[1].branch };
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
    expect(await readPublicationWorktreeState(source)).toEqual(before);
    expect(source.effects).toEqual(["push", "pull_request"]);
    expect(
      await invoke(publicationSource, true, "local-checkout", "retry-publication-run"),
    ).toEqual(result);
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);
    expect(await readPublicationWorktreeState(source)).toEqual(before);
    expect(source.effects).toEqual(["push", "pull_request"]);
    if (managed) {
      return;
    }
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

    if (outcome === "task access") {
      const taskHead = await source.git("-C", task.entry.spawnedCwd!, "rev-parse", "HEAD");
      await fs.writeFile(path.join(source.cwd, "artifact.txt"), "guest follow-up\n");
      await source.git("commit", "-am", "Guest follow-up");
      requesterClient = f.guestSource.client;
      expect(await invoke(source.cwd, true, "guest-follow-up")).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining("requester is no longer authorized") },
      ]);
      expect(await source.git("-C", task.entry.spawnedCwd!, "rev-parse", "HEAD")).toBe(taskHead);
      expect(source.effects).toEqual(["push", "pull_request"]);
      requesterClient = f.maintainerSource.client;
      let revoked = false;
      const requireGit = worktreeGit.requireGit;
      const observeGit = vi.spyOn(worktreeGit, "requireGit").mockImplementation(async (...args) => {
        const readResult = await requireGit(...args);
        if (args[1].includes("--format=%H%n%T%n%an%n%ae%n%cn%n%ce")) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: task.sessionKey },
            { lifecycleRevision: "replacement-publication-task" },
          );
          revoked = true;
        }
        return readResult;
      });
      onTestFinished(() => observeGit.mockRestore());
      const revokedResult = await invoke(source.cwd, true, "revoked-task-follow-up");
      expect(revoked).toBe(true);
      expect(await source.git("-C", task.entry.spawnedCwd!, "rev-parse", "HEAD")).toBe(taskHead);
      expect(source.effects).toEqual(["push", "pull_request"]);
      expect(revokedResult).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining("session authorization is unavailable") },
      ]);
      return;
    }

    if (projectId) {
      if (outcome === "linked project worktree") {
        expect(await fs.readFile(path.join(linked, "artifact.txt"), "utf8")).toBe("another chat\n");
      }
      if (outcome === "project") {
        projectVisibility = "private";
        // A retry checks current access again before it reaches the accepted receipt.
        for (const key of ["local-checkout", "new-project-task"]) {
          expect(await invoke(publicationSource, true, key)).toMatchObject([
            false,
            undefined,
            { message: expect.stringContaining("project is unavailable to this requester") },
          ]);
        }
        expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);
        expect(source.effects).toEqual(["push", "pull_request"]);
      }
      return;
    }

    // Fixing CI, or amending, in the same checkout updates its task, branch and PR.
    for (const [text, args] of [
      ["follow-up\n", ["commit", "-qam", "Fix CI"]],
      ["amended\n", ["commit", "-qa", "--amend", "--no-edit"]],
    ] as const) {
      await fs.writeFile(path.join(source.cwd, "artifact.txt"), text);
      expect(await invoke(source.cwd, true, "local-checkout")).toEqual(result);
      await source.git(...args);
      const acceptedHead = await source.git("-C", task.entry.spawnedCwd!, "rev-parse", "HEAD");
      expect(await invoke(source.cwd, true, "local-checkout")).toEqual(result);
      expect(await source.git("-C", task.entry.spawnedCwd!, "rev-parse", "HEAD")).toBe(
        acceptedHead,
      );
      expect(await invoke(source.cwd, true, text)).toMatchObject([
        true,
        { status: "published", ...publicationTarget },
      ]);
      expect(await fs.readFile(path.join(task.entry.spawnedCwd!, "artifact.txt"), "utf8")).toBe(
        text,
      );
    }
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(1);
    expect(source.effects).toEqual(["push", "pull_request", "push", "push"]);
    if (outcome === "rebased task") {
      const upstream = path.join(root, "upstream");
      await source.git("worktree", "add", "--detach", upstream, "main");
      await fs.writeFile(path.join(upstream, "shared.txt"), "upstream improvement\n");
      await source.git("-C", upstream, "add", "shared.txt");
      await source.git("-C", upstream, "commit", "-m", "Upstream includes the shared change");
      const base = await source.git("-C", upstream, "rev-parse", "HEAD");
      const tree = await source.git("rev-parse", "HEAD^{tree}");
      await source.git("rebase", base);
      expect(await source.git("rev-parse", "HEAD^{tree}")).toBe(tree);
      overrideCommands((argv) =>
        argv.some((arg) => arg.endsWith("/git/ref/heads/main"))
          ? commandResult(JSON.stringify({ ref: "refs/heads/main", sha: base }))
          : undefined,
      );
      const rebased = await invoke(source.cwd, true, "rebased-publication");
      expect(rebased).toMatchObject([true, { status: "published", ...publicationTarget }]);
      expect(await source.git("diff", "--name-only", `${base}...${rebased[1].headCommit}`)).toBe(
        "artifact.txt",
      );
      expect(source.effects.filter((effect) => effect === "pull_request")).toHaveLength(1);
    }
    before = await readPublicationWorktreeState(source);

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
      edits: [{ oldText: "amended\n", newText: "second task\n" }],
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
    const nextPublication = await invoke(other, true, "another-checkout");
    expect(nextPublication, JSON.stringify(nextPublication)).toMatchObject([
      true,
      { status: "published" },
    ]);
    expect(await listSessionChildEntriesReadOnly(scope)).toHaveLength(2);
    expect(loadSessionEntryReadOnly(scope)?.spawnedCwd).toBe(root);
    expect(await readPublicationWorktreeState(source)).toEqual(before);

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
    expect(await invoke(source.cwd)).toMatchObject([
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
  beforeEach(async () => {
    onTestFinished((await prepareUserProfileCatalog()).release);
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
      const f = await createLocalPublicationFixture();
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
      const before = await readPublicationWorktreeState(workspace);
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
        expect(await readPublicationWorktreeState(workspace)).toEqual(before);
      }
    },
  );

  it("invalidates publication metadata after committed workspace and lifecycle updates", async () => {
    await createLocalPublicationFixture();
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
