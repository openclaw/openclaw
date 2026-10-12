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
import {
  bindChildSessionPublication,
  admitChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
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
import { resolveSessionPublicShare } from "../../config/sessions/session-public-share.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  bindGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import { getSessionWorkAdmissionRelease } from "../../sessions/session-lifecycle-admission.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail, syncGitHubIdentity } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { withOperatorToolGatewayAuthority } from "../server-plugin-in-process-dispatch.js";
import { dispatchGatewayMethodInProcess } from "../server-plugins.js";
import { resolveSessionMutationAuthorization } from "../session-sharing.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { getTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { releaseGatewaySessionStoreFixture } from "../test/server-sessions-resources.test-helpers.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { identifiedClient } from "./sessions-sharing.test-support.js";

installGatewayTestHooks();
registerAgentSessionLoopTestLifecycle();
const temporaryDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    // External store leases must retire before the per-case Gateway home.
    for (const dir of temporaryDirs.dirs) {
      await releaseGatewaySessionStoreFixture(dir);
    }
    cleanup();
  });
});

async function createHostedChildFixture(
  system = false,
  toolInvocation = false,
  existingChild = false,
  mismatchedParentOwner = false,
  humanParent = !system,
  sandboxRequired = false,
  mergedParentCreator = false,
  options: {
    foreignSandboxCreator?: boolean;
    parentCreatedVia?: SessionEntry["createdVia"];
    parentCreatorSource?: "profile" | "channel";
  } = {},
) {
  const storePath = path.join(temporaryDirs.make("openclaw-child-custody-"), "sessions.json");
  testState.sessionStorePath = storePath;
  const parentKey = "agent:main:parent";
  const childKey = "agent:main:dashboard:accepted-child";
  const childKeys = [childKey];
  const existingOwnerId = "existing-child-owner";
  const releaseProfileCatalog = mergedParentCreator
    ? (await prepareUserProfileCatalog()).release
    : undefined;
  const profile = ensureProfileForEmail(
    mergedParentCreator ? "child-owner-current@example.test" : "child-owner@example.test",
  );
  const parentCreator = options.foreignSandboxCreator
    ? ensureProfileForEmail("sandbox-creator@example.test")
    : mergedParentCreator
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
              createdVia: options.parentCreatedVia ?? "operator",
              createdActor: {
                type: "human" as const,
                source: options.parentCreatorSource ?? "profile",
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
          handler: expectDefined(sessionCreateHandlers["sessions.create"], "creation owner"),
        },
        {
          name: "sessions.patch",
          scope: "operator.write",
          owner: { kind: "core", area: "sessions" },
          handler: expectDefined(sessionMutationHandlers["sessions.patch"], "mutation owner"),
        },
      ],
      registry,
    );
  const captured = system
    ? undefined
    : await captureGatewayOperatorRunAuthority({
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
      publicRead: boolean;
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
        ...(requesterSessionKey === parentKey
          ? {
              childSessionPublication: readChildSessionPublication(admitted.operationalRunInstance),
            }
          : {}),
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
    enablePublicIngress: () => {
      const ingressContext = {};
      bindChildSessionPublication(ingressContext, parentKey, () => {
        if (!sourceCurrent || !hostCurrent) {
          throw new Error("public source revoked");
        }
      });
      admitChildSessionPublication(ingressContext, admitted.operationalRunInstance, () => {
        if (caller.receiptAuthority?.() === false) {
          throw new Error("public source run closed");
        }
      });
    },
    send,
    sendNested,
    patchAs: (profileId: string, request: Record<string, unknown>) =>
      withPluginRuntimeGatewayRequestScope(
        { context, client: identifiedClient(profileId), isWebchatConnect: () => false },
        () =>
          dispatchGatewayMethodInProcess("sessions.patch", request, {
            resolveGatewayContext: () => context,
          }),
      ),
    readChild: () => loadSessionEntry({ agentId: "main", sessionKey: childKey, storePath }),
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
    finish,
    [Symbol.asyncDispose]: async () => {
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
  it("commits public ingress publication with the fresh child before its first turn, not its descendants", async () => {
    await using fixture = await createHostedChildFixture(true);
    fixture.enablePublicIngress();
    const child = await fixture.send();
    await fixture.dispatchEntered;
    expect(child.publicRead).toBe(true);
    expect(child.entry).not.toHaveProperty("publicShare");
    expect(resolveSessionPublicShare(loadSessionEntry(fixture.scope()))?.sessionId).toBe(
      child.sessionId,
    );
    expect(loadSessionEntry(fixture.parentScope)?.publicShare).toBeUndefined();
    await fixture.finish();
    expect(fixture.provider).toHaveBeenCalledTimes(1);
    const nested = await fixture.sendNested();
    expect(nested.publicRead).toBe(false);
    expect(nested.entry).not.toHaveProperty("publicShare");
  });

  it("does not publish a private source's child", async () => {
    await using fixture = await createHostedChildFixture(true);
    await patchSessionEntryCore(fixture.parentScope, () => ({ visibility: "draft" }));
    fixture.enablePublicIngress();
    await expect(fixture.send()).rejects.toThrow(/non-private child/);
    expect(fixture.provider).not.toHaveBeenCalled();
  });

  it("retains delegated human Git credit without inventing child participation", async () => {
    await using fixture = await createHostedChildFixture();
    syncGitHubIdentity({
      identity: { accountId: 20, login: "ada" },
      authenticationAlias: { kind: "email", email: "child-owner@example.test" },
    });
    await recordSessionParticipant(fixture.parentScope, {
      identity: { type: "profile", id: fixture.profileId },
      promptedAt: 1,
    });

    const accepted = await fixture.send();
    expect(accepted.runStarted).toBe(true);
    expect(accepted.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
    expect(fixture.provider).not.toHaveBeenCalled();
    const scope = fixture.scope();
    const readCredit = () =>
      resolveGitCoauthorAttribution({ ...scope, config: getRuntimeConfig() });
    const expectedCredit = {
      logins: ["ada"],
      trailers: ["Co-authored-by: ada <20+ada@users.noreply.github.com>"],
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
      expect(loadSessionEntry(childScope)?.createdActor).toEqual({
        type: "human",
        source: "profile",
        id: fixture.profileId,
      });
      expect(
        (listSessionParticipantsReadOnly(childScope).get(childScope.sessionKey) ?? []).filter(
          ({ identity }) => identity.type === "profile",
        ),
      ).toEqual([]);
    }
  });

  it("retains the verified requester as the visible child creator and owner", async () => {
    await using fixture = await createHostedChildFixture();
    await fixture.send();
    expect(loadSessionEntry(fixture.scope())).toMatchObject({
      createdActor: { type: "human", source: "profile", id: fixture.profileId },
      owner: {
        actor: { type: "human", id: fixture.profileId },
        assignedBy: { type: "agent", id: "main" },
      },
    });
    await fixture.finish();
    const request = {
      key: fixture.scope().sessionKey,
      expectedSessionId: fixture.scope().sessionId,
      archived: true,
    };
    const other = ensureProfileForEmail("unrelated-viewer@example.test");
    const before = fixture.readChild();
    await expect(fixture.patchAs(other.id, request)).rejects.toThrow(
      "Only the session creator or an admin",
    );
    expect(fixture.readChild()).toEqual(before);
    await expect(fixture.patchAs(fixture.profileId, request)).resolves.toMatchObject({ ok: true });
    expect(loadSessionEntry(fixture.scope())?.archivedAt).toEqual(expect.any(Number));
  });

  it("rejects a revoked requester before durable creation", async () => {
    await using fixture = await createHostedChildFixture();
    fixture.revokeSource();
    await expect(fixture.send()).rejects.toThrow("original operator source revoked");
    expect(fixture.readChild()).toBeUndefined();
    expect(fixture.provider).not.toHaveBeenCalled();
  });

  it("does not attribute autonomous work to an ordinary conversation creator", async () => {
    await using fixture = await createHostedChildFixture(true, false, false, false, true);
    await fixture.send();
    expect(loadSessionEntry(fixture.scope())?.createdActor).toEqual({ type: "agent", id: "main" });
  });

  it.each(["profile", "channel"] as const)(
    "preserves a scheduled %s creator across nested delegation",
    async (source) => {
      await using fixture = await createHostedChildFixture(
        true,
        false,
        false,
        false,
        true,
        false,
        false,
        {
          parentCreatedVia: "cron",
          parentCreatorSource: source,
        },
      );
      await fixture.send();
      await fixture.finish();
      const nested = await fixture.sendNested();
      await fixture.finish();
      for (const scope of [fixture.scope(), fixture.scope(nested.key)]) {
        expect(loadSessionEntry(scope)?.createdActor).toEqual({
          type: "human",
          source,
          id: fixture.profileId,
        });
      }
      const authorization = resolveSessionMutationAuthorization({
        client: identifiedClient(fixture.profileId),
        method: "sessions.patch",
        requestParams: { key: nested.key, archived: true, expectedSessionId: nested.sessionId },
        context: fixture.context,
      });
      if (source === "channel") {
        expect(authorization.error).toMatchObject({ code: "FORBIDDEN" });
      } else {
        expect(authorization.error).toBeNull();
      }
    },
  );

  it("does not replace the owner of an existing target session", async () => {
    await using fixture = await createHostedChildFixture(false, false, true);
    await expect(fixture.send()).rejects.toThrow("spawn tool policy requires a new session");
    expect(loadSessionEntry(fixture.scope())?.owner?.actor).toMatchObject({
      type: "human",
      id: fixture.existingOwnerId,
    });
  });

  it("inherits a historical owner alias into the requester's canonical profile", async () => {
    await using fixture = await createHostedChildFixture(
      false,
      false,
      false,
      false,
      true,
      false,
      true,
    );
    await fixture.send();
    expect(loadSessionEntry(fixture.scope())?.owner?.actor).toEqual({
      type: "human",
      id: fixture.profileId,
    });
  });

  it("does not inherit a different human owner's assignment", async () => {
    await using fixture = await createHostedChildFixture(false, false, false, true);
    await fixture.send();
    expect(loadSessionEntry(fixture.scope())?.createdActor).toEqual({
      type: "human",
      source: "profile",
      id: fixture.profileId,
    });
    expect(loadSessionEntry(fixture.scope())?.owner?.actor).toEqual({
      type: "agent",
      id: "main",
    });
  });

  it("keeps agent ownership when required sandbox provenance retains a human creator", async () => {
    await using fixture = await createHostedChildFixture(true, false, false, false, true, true);
    await fixture.send();
    expect(loadSessionEntry(fixture.scope())).toMatchObject({
      createdActor: { type: "human", source: "profile", id: fixture.profileId },
      owner: { actor: { type: "agent", id: "main" } },
      sandbox: "required",
    });
  });

  it.each([false, true])(
    "continues after the inherited tool invocation completes (system=%s)",
    async (system) => {
      await using fixture = await createHostedChildFixture(system, true);
      const accepted = await fixture.send();
      expect(accepted.runStarted).toBe(true);
      const scope = fixture.scope();
      expect(accepted.sessionId).toBe(scope.sessionId);
      await fixture.dispatchEntered;
      expect(await listSessionPendingInputs(scope)).toMatchObject({
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
      expect(await listSessionPendingInputs(scope)).toEqual({ items: [], total: 0 });
      expect(fixture.context.chatAbortControllers.has(accepted.runId)).toBe(false);
    },
  );

  it.each([false, true])(
    "retains inherited invocation authority through child input COMMIT (system=%s)",
    async (system) => {
      await using fixture = await createHostedChildFixture(system, true);
      fixture.beforeInputCommit.mockImplementation(() => fixture.closeInvocation());
      await expect(fixture.send()).resolves.toMatchObject({
        ok: true,
        runStarted: false,
        runError: {
          code: "UNAVAILABLE",
          message: "Error: inherited tool invocation closed",
        },
      });
      expect(fixture.beforeInputCommit).toHaveBeenCalledOnce();
      expect(await listSessionPendingInputs(fixture.scope())).toEqual({ items: [], total: 0 });
      expect(userMessages(fixture.scope())).toEqual([]);
      expect(fixture.provider).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    },
  );

  it.each(["source", "host", "signal", "gateway", "ACL", "lifecycle", "replacement"] as const)(
    "retains the original %s boundary after child ACK and parent closure",
    async (change) => {
      // A creator keeps access to their own draft. Exercise ACL revocation with
      // a shared sandbox whose isolation creator is a different person instead.
      await using fixture = await createHostedChildFixture(
        false,
        false,
        false,
        false,
        true,
        change === "ACL",
        false,
        { foreignSandboxCreator: change === "ACL" },
      );
      const accepted = await fixture.send();
      expect(accepted.runStarted).toBe(true);
      await fixture.dispatchEntered;
      const scope = fixture.scope();
      const pending = await listSessionPendingInputs(scope);
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
      expect(await listSessionPendingInputs(scope)).toMatchObject({
        total: 1,
        items: [{ id: pending.items[0]?.id, state: "interrupted" }],
      });
      if (change === "replacement") {
        expect(fixture.persistenceResult).toHaveBeenCalledExactlyOnceWith(undefined);
        expect(loadSessionEntry(scope)?.sessionId).toBe("successor-child");
        expect(userMessages({ ...scope, sessionId: "successor-child" })).toEqual([]);
      }
    },
  );

  it.each([false, true])(
    "keeps the parent receipt through child input COMMIT (system=%s)",
    async (system) => {
      await using fixture = await createHostedChildFixture(system);
      fixture.beforeInputCommit.mockImplementation(() => fixture.closeParent());
      await expect(fixture.send()).rejects.toThrow(
        system
          ? "agent tool caller authority is no longer active"
          : "operator execution authority is no longer active",
      );
      expect(fixture.beforeInputCommit).toHaveBeenCalledOnce();
      expect(await listSessionPendingInputs(fixture.scope())).toEqual({ items: [], total: 0 });
      expect(userMessages(fixture.scope())).toEqual([]);
      expect(fixture.provider).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    },
  );
});
