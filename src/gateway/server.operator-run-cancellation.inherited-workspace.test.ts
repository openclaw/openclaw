// Gateway server suites run in native forks, where the shared-state broker owns admission.
import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import type { ManagedWorktreeRecord } from "../agents/worktrees/types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { retainGatewayOperatorRun } from "./operator-run-cancellation.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { gatewayConnect } from "./server/client-fixtures.test-support.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";

async function withInheritedWorkspace(
  run: (fixture: Awaited<ReturnType<typeof prepareInheritedWorkspace>>) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "inherited-project-run", prepareProfileCatalog: true },
    async (state) => {
      const fixture = await prepareInheritedWorkspace(state.workspaceDir);
      using _ = { [Symbol.dispose]: fixture.release };
      await run(fixture);
    },
  );
}

async function prepareInheritedWorkspace(root: string) {
  const cfg = rolePolicyConfig();
  cfg.gateway!.roles!.definitions.view!.scopes.push("operator.sessions.write");
  setRuntimeConfigSnapshot(cfg);
  const guest = createOperatorClient({
    profileName: "project-helper-guest",
    scopes: ["operator.read", "operator.write"],
  });
  const guestId = guest.authenticatedUserProfile!.profileId;
  const context = createContext([], () => cfg);
  context.resolveGatewayContext = () => context;
  const profileCatalog = await prepareUserProfileCatalog();
  const resources = new DisposableStack();
  resources.defer(profileCatalog.release);
  const parentKey = "agent:main:parent-project";
  const childKey = "agent:main:subagent:project-helper";
  const target = (sessionKey: string) => ({ agentId: "main", sessionKey });
  const worktree: ManagedWorktreeRecord = {
    id: "shared-parent-project",
    name: "shared-project",
    repoFingerprint: "synthetic-project",
    repoRoot: path.join(root, "repository"),
    path: path.join(root, "checkout"),
    branch: "helper-project",
    baseRef: "main",
    ownerKind: "session",
    ownerId: parentKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
  await insertRegistryWorktree(process.env, worktree);
  const parent: InternalSessionEntry = {
    sessionId: "parent-id",
    lifecycleRevision: "parent-generation",
    updatedAt: 1,
    visibility: "read-only",
    createdActor: { type: "human", source: "profile", id: "project-owner" },
    worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
  };
  const child: InternalSessionEntry = {
    sessionId: "child-id",
    updatedAt: 1,
    createdActor: { type: "human", source: "profile", id: guestId },
    spawnedBy: parentKey,
    spawnedBySessionId: parent.sessionId,
    parentSessionLifecycleRevision: parent.lifecycleRevision,
    spawnedWorkspaceDir: worktree.path,
    inheritedWorktreeId: worktree.id,
  };
  await replaceSessionEntry(target(parentKey), parent);
  await replaceSessionEntry(target(childKey), child);
  const invite = () =>
    addSessionMember(target(parentKey), {
      identityId: guestId,
      addedBy: "project-owner",
      expectedSessionId: parent.sessionId,
    });
  invite();
  const admit = async (client: GatewayClient = guest, entry = child) => {
    const admitted = await retainGatewayOperatorRun({
      client,
      context,
      runId: "child-run",
      spawnedBy: entry.spawnedBy,
      workspaceSession: { ...target(childKey), entry },
    });
    resources.defer(admitted.release);
    return admitted;
  };
  return {
    guest,
    context,
    child,
    admit,
    invite,
    release: () => resources.dispose(),
    revokeMembership: () => removeSessionMember(target(parentKey), guestId),
    updateParent: (patch: Partial<InternalSessionEntry>) =>
      replaceSessionEntry(target(parentKey), { ...parent, ...patch }),
    updateChild: (patch: Partial<InternalSessionEntry>) =>
      replaceSessionEntry(target(childKey), { ...child, ...patch }),
    authorizeChild: async () => {
      const authorized = await resolveSessionMutationAuthorizationAsync({
        client: guest,
        context,
        method: "agent",
        requestParams: { sessionKey: childKey },
      });
      resources.defer(() => authorized.authorization?.release?.());
      return authorized;
    },
  };
}

describe("inherited project run authority", () => {
  it.each(["membership", "visibility"] as const)(
    "keeps child custody after its parent turn, but rejects parent %s revocation",
    async (revocation) => {
      await withInheritedWorkspace(async (f) => {
        const source = new AbortController();
        const parent = await captureGatewayOperatorRunAuthority({
          client: f.guest,
          context: f.context,
          sourceAuthority: {
            signal: source.signal,
            assertCurrent: () => source.signal.throwIfAborted(),
          },
        });
        using parentLifetime = { [Symbol.dispose]: () => parent?.release() };
        void parentLifetime;
        expect(parent).toBeDefined();
        const nativeClient: GatewayClient = {
          ...f.guest,
          internal: { ...f.guest.internal, operatorRunAuthority: parent!.authority },
        };
        const child = await f.admit(nativeClient);
        const retained = child.authority!.retain!();
        using _ = { [Symbol.dispose]: retained };
        parent!.release();
        child.release();
        await f.updateParent({ updatedAt: 2, lastActivityAt: 2 });
        expect(() => child.authority!.assertCurrent()).not.toThrow();

        if (revocation === "membership") {
          f.revokeMembership();
        } else {
          await f.updateParent({ visibility: "draft" });
        }
        expect((await f.authorizeChild()).error).toBeNull();
        expect(() => child.authority!.assertCurrent()).toThrow(
          SessionMutationAuthorizationChangedError,
        );
        await expect(f.admit()).rejects.toThrow(SessionMutationAuthorizationChangedError);

        // Revocation belongs to this actor. An independently authorized system run still works.
        await expect(
          f.admit({
            connect: gatewayConnect(["operator.admin"]),
            internal: { operatorRoleActor: { kind: "system" } },
          }),
        ).resolves.toMatchObject({ authority: undefined });
        if (revocation === "membership") {
          f.invite();
        } else {
          await f.updateParent({ visibility: "read-only" });
        }
        expect(() => child.authority!.assertCurrent()).toThrow();
        const fresh = await f.admit();
        expect(() => fresh.authority!.assertCurrent()).not.toThrow();
        const delegated = await f.admit(nativeClient);
        source.abort();
        expect(() => delegated.authority!.assertCurrent()).toThrow();
        expect(() => fresh.authority!.assertCurrent()).not.toThrow();
      });
    },
  );

  it("keeps the initiating own-session scope and leaves unmarked helpers unchanged", async () => {
    await withInheritedWorkspace(async (f) => {
      const readOnly = {
        ...f.guest,
        connect: { ...f.guest.connect, scopes: ["operator.read"] },
      };
      await expect(f.admit(readOnly)).rejects.toThrow(SessionMutationAuthorizationChangedError);
      const scoped = {
        ...f.guest,
        connect: { ...f.guest.connect, scopes: ["operator.sessions.write"] },
      };
      await expect(f.admit(scoped, f.child)).rejects.toThrow(
        SessionMutationAuthorizationChangedError,
      );
      await f.updateChild({ inheritedWorktreeId: undefined });
      const legacy = await f.admit(scoped, { ...f.child, inheritedWorktreeId: undefined });
      expect(() => legacy.authority!.assertCurrent()).not.toThrow();
    });
  });
});
