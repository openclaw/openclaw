import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveGitCoauthorAttribution } from "../../agents/git-coauthor-attribution.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayToolWithCreation } from "../../agents/tools/in-process-gateway.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { getRuntimeConfig } from "../../config/config.js";
import {
  assignSessionOwner,
  listSessionParticipantsReadOnly,
  listSessionPendingInputs,
  loadSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  recordSessionParticipant,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { retainUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail, linkEmail, syncGitHubIdentity } from "../../state/user-profiles.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { withOperatorToolGatewayAuthority } from "../server-plugin-in-process-dispatch.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const temporaryDirs = useAutoCleanupTempDirTracker(afterEach);

async function createHostedChildFixture(
  system = false,
  toolInvocation = false,
  existingChild = false,
  mismatchedParentOwner = false,
  humanParent = !system,
  sandboxRequired = false,
  mergedParentCreator = false,
  sharedMain = false,
) {
  const storePath = path.join(temporaryDirs.make("openclaw-child-custody-"), "sessions.json");
  testState.sessionStorePath = storePath;
  const parentKey = sharedMain ? "agent:main:main" : "agent:main:parent";
  const childKey = "agent:main:dashboard:accepted-child";
  const childKeys = [childKey];
  const existingOwnerId = "existing-child-owner";
  const releaseProfileCatalog = mergedParentCreator ? retainUserProfileCatalog() : undefined;
  const profile = ensureProfileForEmail(
    mergedParentCreator ? "child-owner-current@example.test" : "child-owner@example.test",
  );
  const parentCreator = mergedParentCreator
    ? ensureProfileForEmail("child-owner-historical@example.test")
    : profile;
  if (mergedParentCreator) {
    linkEmail("child-owner-historical@example.test", profile.id);
  }
  const parentOwner = mismatchedParentOwner
    ? ensureProfileForEmail("other-parent-owner@example.test")
    : undefined;
  await writeSessionStore({
    entries: {
      [parentKey]: {
        sessionId: "parent-session",
        updatedAt: Date.now(),
        ...(humanParent
          ? {
              createdVia: "operator" as const,
              createdActor: {
                type: "human" as const,
                source: "profile" as const,
                id: parentCreator.id,
              },
              ...(sandboxRequired ? { sandbox: "required" as const } : {}),
            }
          : {}),
      },
      ...(existingChild
        ? {
            [childKey]: {
              sessionId: "existing-child",
              updatedAt: Date.now(),
            },
          }
        : {}),
    },
  });
  if (parentOwner) {
    assignSessionOwner(
      { agentId: "main", sessionKey: parentKey, storePath },
      {
        owner: { type: "human", id: parentOwner.id },
        assignedBy: { type: "system", id: "fixture" },
      },
    );
  }
  if (existingChild) {
    assignSessionOwner(
      { agentId: "main", sessionKey: childKey, storePath },
      {
        owner: { type: "human", id: existingOwnerId },
        assignedBy: { type: "system", id: "fixture" },
      },
    );
  }
  const releaseDispatch = createDeferred();
  const dispatchEntered = createDeferred();
  const provider = vi.fn();
  const persistenceResult = vi.fn();
  let originalHandler: GatewayRequestHandlerOptions | undefined;
  let sourceCurrent = true;
  let hostCurrent = true;
  let gatewayCurrent = true;
  let invocationCurrent = true;
  const signal = new AbortController();
  const beforeInputCommit = vi.fn(() => {});
  const registry = getTestPluginRegistry();
  // A real approval hook keeps input queued until execution promotes it; neither
  // the pending-input owner nor its transcript writer is replaced by a test double.
  registry.typedHooks.push({
    pluginId: "child-custody-fixture",
    hookName: "before_message_write",
    source: "test",
    handler: ({ message }: PluginHookBeforeMessageWriteEvent) => {
      if (message.role === "user") {
        beforeInputCommit();
      }
    },
  });
  initializeGlobalHookRunner(registry);
  dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
    const { replyOptions } = params as Parameters<typeof dispatchInboundMessage>[0];
    const recorder = expectDefined(replyOptions?.userTurnTranscriptRecorder, "child input owner");
    dispatchEntered.resolve();
    await releaseDispatch.promise;
    // The real reply admission owner rejects a missing persistence result before inference.
    const persisted = await recorder.persistApproved();
    persistenceResult(persisted);
    if (!persisted) {
      throw new Error("session changed before durable user-turn admission");
    }
    provider();
    return {};
  });
  const context = createDirectChatContext({ getRuntimeConfig });
  context.readPreparedGatewayModelCatalog = async () => {
    const catalog = await context.loadGatewayModelCatalogSnapshot();
    return { entries: catalog.entries, routeVariants: catalog.routeVariants };
  };
  context.getGatewayMethodRegistry = () =>
    createGatewayMethodRegistry(
      [
        {
          name: "sessions.create",
          scope: "operator.write",
          owner: { kind: "core", area: "sessions" },
          handler: async (options) => {
            originalHandler = options;
            await expectDefined(
              sessionCreateHandlers["sessions.create"],
              "creation owner",
            )(options);
          },
        },
      ],
      registry,
    );
  const captured = system
    ? undefined
    : captureGatewayOperatorRunAuthority({
        client: identifiedClient(profile.id),
        context,
        sourceAuthority: {
          assertCurrent: () => {
            if (!sourceCurrent) {
              throw new Error("original operator source revoked");
            }
          },
        },
      });
  const parent = prepareSystemAgentRunAdmission(
    getRuntimeConfig(),
    "parent-run",
    "main",
    "hosted-child-custody-test",
    undefined,
    captured?.authority,
  );
  const admitted = await parent.admit("embedded");
  // Only the parent, and later the accepted child, retain the issued source.
  captured?.release();
  bindGatewayContextResolver(admitted, () => (gatewayCurrent ? context : undefined));
  const caller = expectDefined(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: parentKey,
    }),
    "admitted parent caller",
  );
  const dispatch = (requesterSessionKey = parentKey, targetKey = childKey, spawnDepth = 1) =>
    callInProcessGatewayToolWithCreation<{
      key: string;
      sessionId: string;
      runId: string;
      runStarted: boolean;
      entry: SessionEntry;
    }>(
      "sessions.create",
      {
        agentId: "main",
        key: targetKey,
        parentSessionKey: requesterSessionKey,
        spawnDepth,
        task: "Continue independently.",
      },
      {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey,
        inheritedToolPolicy: { version: 1, allow: [], deny: [] },
      },
      {
        signal: signal.signal,
        sessionMutationCommitGuard: () => {
          if (!hostCurrent) {
            throw new Error("explicit input host closed");
          }
        },
      },
    );
  const send = () =>
    withGatewayToolCallerIdentity(caller, () =>
      toolInvocation
        ? withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: system
                ? undefined
                : identifiedClient(profile.id).authenticatedUserProfile,
              operatorRoleActor: system ? { kind: "system" } : undefined,
              operatorRunAuthority: caller.operatorAuthority,
              scopes: caller.operatorAuthority?.scopes ?? ["operator.write"],
              assertCurrent: () => {
                if (!invocationCurrent) {
                  throw new Error("inherited tool invocation closed");
                }
              },
            },
            dispatch,
          )
        : dispatch(),
    );
  const sendNested = async () => {
    const nested = prepareSystemAgentRunAdmission(
      getRuntimeConfig(),
      "nested-parent-run",
      "main",
      "hosted-child-custody-test",
      undefined,
      caller.operatorAuthority,
    );
    try {
      const nestedAdmission = await nested.admit("embedded");
      bindGatewayContextResolver(nestedAdmission, () => (gatewayCurrent ? context : undefined));
      const nestedCaller = createAdmittedGatewayToolCallerIdentity({
        admittedRunContext: nestedAdmission,
        agentId: "main",
        sessionKey: childKey,
      });
      const nestedKey = "agent:main:dashboard:accepted-grandchild";
      childKeys.push(nestedKey);
      return await withGatewayToolCallerIdentity(nestedCaller, () =>
        dispatch(childKey, nestedKey, 2),
      );
    } finally {
      nested.close();
    }
  };
  const scope = (sessionKey = childKey) => ({
    agentId: "main",
    sessionKey,
    sessionId: expectDefined(loadSessionEntry({ sessionKey, storePath }), "child row").sessionId,
    storePath,
  });
  const finish = async () => {
    const drains = childKeys.map((key) => {
      const row = loadSessionEntry({ sessionKey: key, storePath });
      return row
        ? getSessionWorkAdmissionRelease({ scope: storePath, identities: [key, row.sessionId] })
        : undefined;
    });
    releaseDispatch.resolve();
    await Promise.all(drains.filter((drain) => drain !== undefined));
  };
  return {
    send,
    sendNested,
    scope,
    context,
    parentScope: { agentId: "main", sessionKey: parentKey, storePath },
    profileId: profile.id,
    existingOwnerId,
    beforeInputCommit,
    provider,
    persistenceResult,
    dispatchEntered: dispatchEntered.promise,
    closeParent: () => parent.close(),
    closeInvocation: () => {
      invocationCurrent = false;
    },
    revokeSource: () => {
      sourceCurrent = false;
    },
    closeHost: () => {
      hostCurrent = false;
    },
    closeGateway: () => {
      gatewayCurrent = false;
    },
    abortSignal: () => signal.abort(new Error("explicit request signal closed")),
    replaceHandler: () => {
      expectDefined(originalHandler, "original request handler").context =
        createDirectChatContext();
    },
    finish,
    cleanup: async () => {
      try {
        await finish();
      } finally {
        parent.close();
        captured?.release();
        releaseProfileCatalog?.();
        dispatchInboundMessageMock.mockReset();
      }
    },
  };
}

function userMessages(
  scope: ReturnType<Awaited<ReturnType<typeof createHostedChildFixture>>["scope"]>,
) {
  return loadTranscriptEventsSync(scope).filter(
    (entry) =>
      isRecord(entry) &&
      entry.type === "message" &&
      isRecord(entry.message) &&
      entry.message.role === "user",
  );
}

describe("hosted creation transfers accepted child input", () => {
  it.each([false, true])(
    "scopes delegated Git credit without child participation (sharedMain=%s)",
    async (sharedMain) => {
      const fixture = await createHostedChildFixture(
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        sharedMain,
      );
      try {
        syncGitHubIdentity({
          identity: { accountId: 20, login: "ada" },
          authenticationAlias: { kind: "email", email: "child-owner@example.test" },
        });
        await recordSessionParticipant(fixture.parentScope, {
          identity: { type: "profile", id: fixture.profileId },
          promptedAt: 1,
        });

        const collaborator = ensureProfileForEmail("collaborator@example.test");
        syncGitHubIdentity({
          identity: { accountId: 22, login: "collaborator" },
          authenticationAlias: { kind: "email", email: "collaborator@example.test" },
        });
        await recordSessionParticipant(fixture.parentScope, {
          identity: { type: "profile", id: collaborator.id },
          promptedAt: 1,
        });
        const accepted = await fixture.send();
        expect(accepted.runStarted).toBe(true);
        expect(accepted.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
        expect(fixture.provider).not.toHaveBeenCalled();
        const scope = fixture.scope();
        const readCredit = () =>
          resolveGitCoauthorAttribution({ ...scope, config: getRuntimeConfig() });
        const candidates = [
          { id: fixture.profileId, login: "ada", accountId: 20 },
          ...(!sharedMain ? [{ id: collaborator.id, login: "collaborator", accountId: 22 }] : []),
        ].toSorted((a, b) => a.id.localeCompare(b.id));
        const expectedCredit = {
          logins: candidates.map(({ login }) => login),
          trailers: candidates.map(
            ({ login, accountId }) =>
              `Co-authored-by: ${login} <${accountId}+${login}@users.noreply.github.com>`,
          ),
        };
        await expect(readCredit()).resolves.toEqual(expectedCredit);

        const later = ensureProfileForEmail("later-contributor@example.test");
        syncGitHubIdentity({
          identity: { accountId: 21, login: "grace" },
          authenticationAlias: { kind: "email", email: "later-contributor@example.test" },
        });
        await recordSessionParticipant(fixture.parentScope, {
          identity: { type: "profile", id: later.id },
          promptedAt: 2,
        });
        await expect(readCredit()).resolves.toEqual(expectedCredit);
        await fixture.finish();
        expect(fixture.provider).toHaveBeenCalledOnce();
        const nested = await fixture.sendNested();
        expect(nested.runStarted).toBe(true);
        expect(nested.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
        await expect(
          resolveGitCoauthorAttribution({
            ...fixture.scope(nested.key),
            config: getRuntimeConfig(),
          }),
        ).resolves.toEqual(expectedCredit);
        await fixture.finish();
        expect(fixture.provider).toHaveBeenCalledTimes(2);
        for (const childScope of [scope, fixture.scope(nested.key)]) {
          expect(
            (listSessionParticipantsReadOnly(childScope).get(childScope.sessionKey) ?? []).filter(
              ({ identity }) => identity.type === "profile",
            ),
          ).toEqual([]);
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it("assigns the verified requester as the visible child owner", async () => {
    const fixture = await createHostedChildFixture();
    try {
      await fixture.send();
      expect(loadSessionEntry(fixture.scope())?.owner).toMatchObject({
        actor: { type: "human", id: fixture.profileId },
        assignedBy: { type: "agent", id: "main" },
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not replace the owner of an existing target session", async () => {
    const fixture = await createHostedChildFixture(false, false, true);
    try {
      await expect(fixture.send()).rejects.toThrow("spawn tool policy requires a new session");
      expect(loadSessionEntry(fixture.scope())?.owner?.actor).toMatchObject({
        type: "human",
        id: fixture.existingOwnerId,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("inherits a historical owner alias into the requester's canonical profile", async () => {
    const fixture = await createHostedChildFixture(false, false, false, false, true, false, true);
    try {
      await fixture.send();
      expect(loadSessionEntry(fixture.scope())?.owner?.actor).toEqual({
        type: "human",
        id: fixture.profileId,
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not inherit a different human owner's assignment", async () => {
    const fixture = await createHostedChildFixture(false, false, false, true);
    try {
      await fixture.send();
      expect(loadSessionEntry(fixture.scope())?.owner?.actor).toEqual({
        type: "agent",
        id: "main",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("does not inherit a human parent owner without an active human requester", async () => {
    const fixture = await createHostedChildFixture(true, false, false, false, true);
    try {
      await fixture.send();
      expect(loadSessionEntry(fixture.scope())?.owner?.actor).toEqual({
        type: "agent",
        id: "main",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps agent ownership when required sandbox provenance retains a human creator", async () => {
    const fixture = await createHostedChildFixture(true, false, false, false, true, true);
    try {
      await fixture.send();
      expect(loadSessionEntry(fixture.scope())).toMatchObject({
        createdActor: { type: "human", source: "profile", id: fixture.profileId },
        owner: { actor: { type: "agent", id: "main" } },
        sandbox: "required",
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([false, true])(
    "continues after the inherited tool invocation completes (system=%s)",
    async (system) => {
      const fixture = await createHostedChildFixture(system, true);
      try {
        const accepted = await fixture.send();
        expect(accepted.runStarted).toBe(true);
        const scope = fixture.scope();
        expect(accepted.sessionId).toBe(scope.sessionId);
        await fixture.dispatchEntered;
        expect(listSessionPendingInputs(scope)).toMatchObject({
          total: 1,
          items: [{ state: "queued" }],
        });
        expect(userMessages(scope)).toEqual([]);
        // Returning from send has already aborted the real invocation envelope's signal.
        fixture.closeInvocation();
        fixture.closeParent();
        await fixture.finish();
        expect(fixture.provider).toHaveBeenCalledOnce();
        expect(userMessages(scope)).toHaveLength(1);
        expect(listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
        expect(fixture.context.chatAbortControllers.has(accepted.runId)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "retains inherited invocation authority through child input COMMIT (system=%s)",
    async (system) => {
      const fixture = await createHostedChildFixture(system, true);
      fixture.beforeInputCommit.mockImplementation(() => fixture.closeInvocation());
      try {
        await expect(fixture.send()).resolves.toMatchObject({
          ok: true,
          runStarted: false,
          runError: {
            code: "UNAVAILABLE",
            message: "Error: inherited tool invocation closed",
          },
        });
        expect(fixture.beforeInputCommit).toHaveBeenCalledOnce();
        expect(listSessionPendingInputs(fixture.scope())).toEqual({ items: [], total: 0 });
        expect(userMessages(fixture.scope())).toEqual([]);
        expect(fixture.provider).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "continues after the admitted parent closes (system=%s)",
    async (system) => {
      const fixture = await createHostedChildFixture(system);
      try {
        const accepted = await fixture.send();
        expect(accepted.runStarted).toBe(true);
        const scope = fixture.scope();
        expect(accepted.sessionId).toBe(scope.sessionId);
        await fixture.dispatchEntered;
        const pending = listSessionPendingInputs(scope);
        expect(pending).toMatchObject({ total: 1, items: [{ state: "queued" }] });
        expect(userMessages(scope)).toEqual([]);
        fixture.closeParent();
        await fixture.finish();
        expect(fixture.provider).toHaveBeenCalledOnce();
        expect(userMessages(scope)).toHaveLength(1);
        expect(listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
        expect(fixture.context.chatAbortControllers.has(accepted.runId)).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([
    "source",
    "host",
    "signal",
    "gateway",
    "handler",
    "ACL",
    "lifecycle",
    "replacement",
  ] as const)(
    "retains the original %s boundary after child ACK and parent closure",
    async (change) => {
      const fixture = await createHostedChildFixture();
      try {
        const accepted = await fixture.send();
        expect(accepted.runStarted).toBe(true);
        await fixture.dispatchEntered;
        const scope = fixture.scope();
        const pending = listSessionPendingInputs(scope);
        expect(pending).toMatchObject({ total: 1, items: [{ state: "queued" }] });
        fixture.closeParent();
        if (change === "source") {
          fixture.revokeSource();
        } else if (change === "host") {
          fixture.closeHost();
        } else if (change === "signal") {
          fixture.abortSignal();
        } else if (change === "gateway") {
          fixture.closeGateway();
        } else if (change === "handler") {
          fixture.replaceHandler();
        } else if (change === "ACL") {
          await patchSessionEntryCore(scope, () => ({ visibility: "draft" }));
        } else if (change === "lifecycle") {
          await patchSessionEntryCore(scope, () => ({ lifecycleRevision: "replaced-generation" }));
        } else {
          replaceSessionEntrySync(scope, { sessionId: "successor-child", updatedAt: Date.now() });
        }
        await fixture.finish();
        expect(fixture.provider).not.toHaveBeenCalled();
        expect(userMessages(scope)).toEqual([]);
        expect(listSessionPendingInputs(scope)).toMatchObject({
          total: 1,
          items: [{ id: pending.items[0]?.id, state: "interrupted" }],
        });
        if (change === "replacement") {
          expect(fixture.persistenceResult).toHaveBeenCalledExactlyOnceWith(undefined);
          expect(loadSessionEntry(scope)?.sessionId).toBe("successor-child");
          expect(userMessages({ ...scope, sessionId: "successor-child" })).toEqual([]);
        }
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it.each([false, true])(
    "keeps the parent receipt through child input COMMIT (system=%s)",
    async (system) => {
      const fixture = await createHostedChildFixture(system);
      fixture.beforeInputCommit.mockImplementation(() => fixture.closeParent());
      try {
        await expect(fixture.send()).rejects.toThrow(
          system
            ? "agent tool caller authority is no longer active"
            : "operator execution authority is no longer active",
        );
        expect(fixture.beforeInputCommit).toHaveBeenCalledOnce();
        expect(listSessionPendingInputs(fixture.scope())).toEqual({ items: [], total: 0 });
        expect(userMessages(fixture.scope())).toEqual([]);
        expect(fixture.provider).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        await fixture.cleanup();
      }
    },
  );
});
