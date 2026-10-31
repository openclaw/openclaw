// Register shared transport mocks before publication owners load.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  root,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../agents/spawned-context.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { deleteRegistryWorktree } from "../agents/worktrees/registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { prepareGitHubPublicationSession } from "./github-publication-availability.js";
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
import { resolveSessionWorkspaceRoots } from "./session-workspace-roots.js";
import * as allocation from "./session-worktree-preparation.js";

const mocks = githubPublicationTestMocks();
const createFixture = () =>
  createRequesterPublicationFixture(vi.fn(), "local", {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });

async function worktreeState(
  workspace: NonNullable<Awaited<ReturnType<typeof createFixture>>["local"]>,
) {
  return {
    head: await workspace.git("rev-parse", "HEAD"),
    index: await fs.readFile(path.join(workspace.cwd, ".git/index")),
    diff: await workspace.git("diff", "HEAD"),
  };
}

describe("local checkout publication", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    realWorktree: true,
  });
  it("publishes an owned checkout outside the default workspace without admin", async () => {
    const f = await createFixture();
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
    for (const other of [workspace, root, path.join(source.cwd, ".git"), "repository"]) {
      expect(await invoke(other)).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining("current managed worktree") },
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

  it.each(["published", "before binding", "before push", "before PR"] as const)(
    "local checkout outcome: %s",
    async (outcome) => {
      const f = await createFixture();
      const source = f.local!;
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      setRuntimeConfigSnapshot({
        ...f.config,
        agents: { entries: { main: { workspace: root } } },
      });
      await deleteRegistryWorktree(process.env, loadSessionEntryReadOnly(scope)!.worktree!.id);
      await upsertSessionEntryCore(scope, {
        worktree: undefined,
        sessionRoot: source.cwd,
        spawnedCwd: source.cwd,
        spawnedWorkspaceDir: source.cwd,
        spawnedBy: "agent:main:parent",
        thinkingLevel: "high",
        label: "Existing task",
        skillsSnapshot: {
          prompt: "",
          skills: [],
          librarySelections: [
            {
              skillId: "11111111-1111-4111-8111-111111111111",
              revision: "a".repeat(64),
              name: "notes",
              ownerProfileId: f.guestProfile,
            },
          ],
        },
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
      const requester = f.guestSource;
      const context = {
        ...createDirectChatContext({ getRuntimeConfig }),
        workerSessionPlacementService: f.placements,
        githubPublicationService: f.coordinator,
      };
      const invoke = async (handoff = true, workspacePath = source.cwd) => {
        const respond = vi.fn();
        const params = {
          sessionKey: SESSION_KEY,
          idempotencyKey: "local-checkout",
          workspacePath,
        };
        await withGatewayToolCallerIdentity(
          {
            ...scope,
            ...(handoff ? { workspacePrAdoptionSessionId: SESSION_ID } : {}),
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
              client: requester.client,
              isWebchatConnect: () => false,
              respond,
            }),
        );
        return respond.mock.calls[0];
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
      const before = await worktreeState(source);
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
      const result = await invoke();
      expect(await worktreeState(source)).toEqual(before);
      if (outcome !== "published") {
        expect(result).toMatchObject(
          outcome === "before binding"
            ? [false, undefined, { message: expect.stringContaining("no longer authorized") }]
            : [
                false,
                undefined,
                { code: "FORBIDDEN", message: expect.stringContaining("role changed") },
              ],
        );
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
      const prepared = loadSessionEntryReadOnly(scope)!;
      expect(prepared.spawnedCwd).not.toBe(source.cwd);
      expect(prepared).toMatchObject({
        thinkingLevel: "high",
        label: "Existing task",
        priorWorkspace: { fileRoot: source.cwd },
      });
      const resumedRoot = resolveIngressWorkspaceOverrideForSessionRun({
        spawnedBy: prepared.spawnedBy,
        workspaceDir: prepared.spawnedWorkspaceDir,
        cwd: prepared.spawnedCwd,
      });
      expect(resumedRoot).toBe(prepared.spawnedCwd);
      expect(resolveSessionWorkspaceRoots(getRuntimeConfig(), "main", prepared).root).toBe(
        resumedRoot,
      );
      expect(await fs.readFile(path.join(prepared.spawnedCwd!, "artifact.txt"), "utf8")).toBe(
        "accepted\n",
      );
      expect(await worktreeState(source)).toEqual(before);
      expect(source.effects).toEqual(["push", "pull_request"]);
      expect(await invoke(true, prepared.spawnedCwd)).toEqual(result);
      // The original source is not the adopted checkout, even though it supplies skills.
      expect(await invoke()).toMatchObject([
        false,
        undefined,
        { message: expect.stringContaining("current managed worktree") },
      ]);
      expect(await worktreeState(source)).toEqual(before);
      expect(source.effects).toEqual(["push", "pull_request"]);
    },
  );
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
