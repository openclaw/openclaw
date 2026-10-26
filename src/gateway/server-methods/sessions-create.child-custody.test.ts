import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { resolveGitCoauthorAttribution } from "../../agents/git-coauthor-attribution.js";
import { SANDBOX_DEFAULT_TOOL_ALLOW } from "../../agents/sandbox/types.js";
import { registerAgentSessionLoopTestLifecycle } from "../../agents/sessions/agent-session-loop-correctness.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayToolWithCreation } from "../../agents/tools/in-process-gateway.js";
import { prepareSandboxSessionTools } from "../../agents/tools/sessions-operator-authority.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { withVisibleWorkSessionReporter } from "../../auto-reply/reply/visible-work-sessions.js";
import {
  bindChildSessionPublication,
  admitChildSessionPublication,
  readChildSessionPublication,
} from "../../channels/message-access/child-session-publication.js";
import { getRuntimeConfig } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
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
import { bindGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginHookBeforeMessageWriteEvent } from "../../plugins/types.js";
import {
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail, syncGitHubIdentity } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
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
import { releaseGatewaySessionStoreFixture } from "../test/server-sessions-resources.test-helpers.js";
import { sessionCreateHandlers } from "./sessions-create.js";
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
const parentKey = "agent:main:parent";
const childKey = "agent:main:dashboard:accepted-child";

async function createHostedChildFixture({
  system = false,
  toolInvocation = false,
  existingChild = false,
  mismatchedParentOwner = false,
  humanParent = !system,
  sandboxRequired = false,
  mergedParentCreator = false,
  channelParent = false,
}: {
  system?: boolean;
  toolInvocation?: boolean;
  existingChild?: boolean;
  mismatchedParentOwner?: boolean;
  humanParent?: boolean;
  sandboxRequired?: boolean;
  mergedParentCreator?: boolean;
  channelParent?: boolean;
} = {}) {
  const storePath = path.join(temporaryDirs.make("openclaw-child-custody-"), "sessions.json");
  testState.sessionStorePath = storePath;
  const childKeys = [childKey];
  const existingOwnerId = "existing-child-owner";
  const releaseProfileCatalog = mergedParentCreator
    ? (await prepareUserProfileCatalog()).release
    : undefined;
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
  const parentEntry: SessionEntry = { sessionId: "parent-session", updatedAt: Date.now() };
  if (humanParent) {
    parentEntry.createdVia = "operator";
    parentEntry.createdActor = { type: "human", source: "profile", id: parentCreator.id };
    if (sandboxRequired) {
      parentEntry.sandbox = "required";
    }
  }
  if (channelParent) {
    parentEntry.createdVia = "channel";
    parentEntry.createdActor = { type: "human", source: "channel", id: "10" };
  }
  const entries: Record<string, SessionEntry> = { [parentKey]: parentEntry };
  if (existingChild) {
    entries[childKey] = { sessionId: "existing-child", updatedAt: Date.now() };
  }
  await writeSessionStore({ entries });
  for (const [sessionKey, id] of [
    [parentKey, parentOwner?.id],
    [childKey, existingChild ? existingOwnerId : undefined],
  ] as const) {
    if (!id) {
      continue;
    }
    assignSessionOwner(
      { agentId: "main", sessionKey, storePath },
      { owner: { type: "human", id }, assignedBy: { type: "system", id: "fixture" } },
    );
  }
  const releaseDispatch = createDeferred();
  const dispatchEntered = createDeferred();
  const provider = vi.fn();
  const persistenceResult = vi.fn();
  const renamePolicy = vi.fn();
  const current = { source: true, host: true, gateway: true, invocation: true };
  const guard = (key: keyof typeof current, message: string) => () => {
    if (!current[key]) {
      throw new Error(message);
    }
  };
  const close = (key: keyof typeof current) => () => {
    current[key] = false;
  };
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
    if (toolInvocation && !system) {
      const allow = ["read"];
      // Reply tool-policy preparation runs before the child binds its own tool caller.
      renamePolicy(
        prepareSandboxSessionTools({
          policy: { allow, deny: [], [SANDBOX_DEFAULT_TOOL_ALLOW]: allow },
          senderIsOwner: false,
          authority: replyOptions?.operatorAuthority,
        }),
      );
    }
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
      ],
      registry,
    );
  const captured = system
    ? undefined
    : await captureGatewayOperatorRunAuthority({
        client: identifiedClient(profile.id),
        context,
        sourceAuthority: {
          assertCurrent: guard("source", "original operator source revoked"),
        },
      });
  const prepareParent = (
    runId: string,
    authority: Parameters<typeof prepareSystemAgentRunAdmission>[5],
  ) =>
    prepareSystemAgentRunAdmission(
      getRuntimeConfig(),
      runId,
      "main",
      "hosted-child-custody-test",
      undefined,
      authority,
    );
  const parent = prepareParent("parent-run", captured?.authority);
  const admitted = await parent.admit("embedded");
  // Only the parent, and later the accepted child, retain the issued source.
  captured?.release();
  bindGatewayContextResolver(admitted, () => (current.gateway ? context : undefined));
  const caller = expectDefined(
    createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: parentKey,
    }),
    "admitted parent caller",
  );
  const participants =
    toolInvocation && caller.operatorAuthority
      ? createReplyTurnParticipants({ operatorAuthority: caller.operatorAuthority })
      : undefined;
  if (participants) {
    caller.personalToolParticipants = participants;
    caller.personalToolUser = profile.id;
    caller.personalToolIdentityScoped = true;
  }
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
        // Automatic naming has its own lifecycle tests; custody must not await a title model.
        displayName: "Custody fixture",
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
        sessionMutationCommitGuard: guard("host", "explicit input host closed"),
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
              assertCurrent: guard("invocation", "inherited tool invocation closed"),
            },
            dispatch,
          )
        : dispatch(),
    );
  const sendNested = async () => {
    const nested = prepareParent("nested-parent-run", caller.operatorAuthority);
    try {
      const nestedAdmission = await nested.admit("embedded");
      bindGatewayContextResolver(nestedAdmission, () => (current.gateway ? context : undefined));
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
        ? captureSessionControllerSettlement({
            target: captureSessionTarget({
              storeScope: storePath,
              sessionKey: key,
              incarnation: row.sessionId,
              agentId: "main",
            }),
          })
        : undefined;
    });
    releaseDispatch.resolve();
    await Promise.all(drains.filter((drain) => drain !== undefined));
  };
  const closeParent = () => {
    participants?.close();
    parent.close();
  };
  return {
    enablePublicIngress: () => {
      const ingressContext = {};
      bindChildSessionPublication(ingressContext, parentKey, () => {
        if (!current.source || !current.host) {
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
    scope,
    parentScope: { agentId: "main", sessionKey: parentKey, storePath },
    profileId: profile.id,
    existingOwnerId,
    beforeInputCommit,
    provider,
    persistenceResult,
    renamePolicy,
    dispatchEntered: dispatchEntered.promise,
    closeParent,
    closeInvocation: close("invocation"),
    revoke: {
      source: close("source"),
      host: close("host"),
      gateway: close("gateway"),
      signal: () => signal.abort(new Error("explicit request signal closed")),
    },
    finish,
    [Symbol.asyncDispose]: async () => {
      try {
        await finish();
      } finally {
        closeParent();
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

type ChildFixture = Awaited<ReturnType<typeof createHostedChildFixture>>;

async function expectQueued(
  fixture: ChildFixture,
  accepted: { runStarted: boolean; sessionId: string },
) {
  expect(accepted.runStarted).toBe(true);
  const scope = fixture.scope();
  expect(accepted.sessionId).toBe(scope.sessionId);
  await fixture.dispatchEntered;
  const pending = await listSessionPendingInputs(scope);
  expect(pending).toMatchObject({
    total: 1,
    items: [{ state: "queued" }],
  });
  expect(userMessages(scope)).toEqual([]);
  return { scope, pending };
}

async function expectCompleted(fixture: ChildFixture, runId: string) {
  await fixture.finish();
  expect(fixture.provider).toHaveBeenCalledOnce();
  expect(userMessages(fixture.scope())).toHaveLength(1);
  expect(await listSessionPendingInputs(fixture.scope())).toEqual({ items: [], total: 0 });
  expect(rpcSourceTesting.has(runId)).toBe(false);
}

async function expectNoInput(fixture: ChildFixture) {
  expect(fixture.beforeInputCommit).toHaveBeenCalledOnce();
  expect(await listSessionPendingInputs(fixture.scope())).toEqual({ items: [], total: 0 });
  expect(userMessages(fixture.scope())).toEqual([]);
  expect(fixture.provider).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
}

describe("hosted creation transfers accepted child input", () => {
  it.each([
    {
      name: "public session URL",
      gateway: { publicOrigin: "https://public-proof.example.test" },
      url: "https://public-proof.example.test/chat/main/dashboard/accepted-child",
    },
    { name: "no public origin", gateway: {}, url: undefined },
    {
      name: "disabled Control UI",
      gateway: {
        publicOrigin: "https://public-proof.example.test",
        controlUi: { enabled: false },
      },
      url: undefined,
    },
  ])(
    "initializes the immediate public child before its first turn with $name",
    async ({ gateway, url }) => {
      await using fixture = await createHostedChildFixture({ system: true });
      fixture.enablePublicIngress();
      setRuntimeConfigSnapshot({
        ...getRuntimeConfig(),
        gateway,
      });
      const reportEntered = createDeferred();
      const releaseReport = createDeferred();
      const report = vi.fn(async () => {
        reportEntered.resolve();
        await releaseReport.promise;
      });
      await withVisibleWorkSessionReporter(
        { requesterSessionKey: fixture.parentScope.sessionKey, report },
        async () => {
          const creating = fixture.send();
          try {
            await awaitGateBeforeSettlement(
              reportEntered.promise,
              fixture.dispatchEntered,
              "Child dispatched before visible-session initialization",
            );
            expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
            expect(report).toHaveBeenCalledExactlyOnceWith(
              url ? [{ sessionKey: childKey, url, publicRead: true }] : [],
              { createdSessionKey: childKey },
            );
          } finally {
            releaseReport.resolve();
          }
          const child = await creating;
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
          expect(report).toHaveBeenCalledTimes(1);
        },
      );
    },
  );

  it("does not publish a private source's child", async () => {
    await using fixture = await createHostedChildFixture({ system: true });
    await patchSessionEntryCore(fixture.parentScope, () => ({ visibility: "draft" }));
    fixture.enablePublicIngress();
    await expect(fixture.send()).rejects.toThrow(/non-private child/);
    expect(fixture.provider).not.toHaveBeenCalled();
  });

  it("retains delegated human Git credit without inventing child participation", async () => {
    await using fixture = await createHostedChildFixture();
    const addContributor = async (
      email: string,
      accountId: number,
      login: string,
      promptedAt: number,
    ) => {
      syncGitHubIdentity({
        identity: { accountId, login },
        authenticationAlias: { kind: "email", email },
      });
      await recordSessionParticipant(fixture.parentScope, {
        identity: { type: "profile", id: ensureProfileForEmail(email).id },
        promptedAt,
      });
    };
    await addContributor("child-owner@example.test", 20, "ada", 1);

    const accepted = await fixture.send();
    expect(accepted.runStarted).toBe(true);
    expect(loadSessionEntry(fixture.scope())?.owner).toMatchObject({
      actor: { type: "human", id: fixture.profileId },
      assignedBy: { type: "agent", id: "main" },
    });
    expect(accepted.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
    expect(fixture.provider).not.toHaveBeenCalled();
    const scope = fixture.scope();
    const readCredit = (key = scope.sessionKey) =>
      resolveGitCoauthorAttribution({ ...fixture.scope(key), config: getRuntimeConfig() });
    const expectedCredit = {
      logins: ["ada"],
      trailers: ["Co-authored-by: ada <20+ada@users.noreply.github.com>"],
    };
    await expect(readCredit()).resolves.toEqual(expectedCredit);

    await addContributor("later-contributor@example.test", 21, "grace", 2);
    await expect(readCredit()).resolves.toEqual(expectedCredit);
    await fixture.finish();
    expect(fixture.provider).toHaveBeenCalledOnce();
    const nested = await fixture.sendNested();
    expect(nested.runStarted).toBe(true);
    expect(nested.entry).not.toHaveProperty("inheritedGitContributorProfileIds");
    await expect(readCredit(nested.key)).resolves.toEqual(expectedCredit);
    await fixture.finish();
    expect(fixture.provider).toHaveBeenCalledTimes(2);
    for (const childScope of [scope, fixture.scope(nested.key)]) {
      expect(
        (listSessionParticipantsReadOnly(childScope).get(childScope.sessionKey) ?? []).filter(
          ({ identity }) => identity.type === "profile",
        ),
      ).toEqual([]);
    }
  });

  it.each([
    {
      name: "verified requester from a channel parent",
      options: { humanParent: false, channelParent: true },
      human: true,
    },
    { name: "canonical historical alias", options: { mergedParentCreator: true }, human: true },
    { name: "different human owner", options: { mismatchedParentOwner: true }, human: false },
  ])("assigns child ownership for a $name", async ({ options, human }) => {
    await using fixture = await createHostedChildFixture(options);
    await fixture.send();
    const owner = loadSessionEntry(fixture.scope())?.owner;
    const actor = { type: human ? "human" : "agent", id: human ? fixture.profileId : "main" };
    expect(owner?.actor).toEqual(actor);
  });

  it("does not replace the owner of an existing target session", async () => {
    await using fixture = await createHostedChildFixture({ existingChild: true });
    await expect(fixture.send()).rejects.toThrow("spawn tool policy requires a new session");
    expect(loadSessionEntry(fixture.scope())?.owner?.actor).toMatchObject({
      type: "human",
      id: fixture.existingOwnerId,
    });
  });

  it("keeps agent ownership when required sandbox provenance retains a human creator", async () => {
    await using fixture = await createHostedChildFixture({
      system: true,
      humanParent: true,
      sandboxRequired: true,
    });
    await fixture.send();
    expect(loadSessionEntry(fixture.scope())).toMatchObject({
      createdActor: { type: "human", source: "profile", id: fixture.profileId },
      owner: { actor: { type: "agent", id: "main" } },
      sandbox: "required",
    });
  });

  it.each([
    { system: false, toolInvocation: false },
    { system: true, toolInvocation: false },
    { system: false, toolInvocation: true },
    { system: true, toolInvocation: true },
  ])(
    "continues after parent closure (system=$system, inherited invocation=$toolInvocation)",
    async (options) => {
      await using fixture = await createHostedChildFixture(options);
      const accepted = await fixture.send();
      await expectQueued(fixture, accepted);
      if (options.toolInvocation) {
        fixture.closeInvocation();
      }
      fixture.closeParent();
      await expectCompleted(fixture, accepted.runId);
      if (options.toolInvocation && !options.system) {
        expect(fixture.renamePolicy).toHaveBeenCalledWith(
          expect.objectContaining({ renameOnly: true }),
        );
      }
    },
  );

  it.each([
    ["invocation", false],
    ["invocation", true],
    ["parent", false],
    ["parent", true],
  ] as const)(
    "retains %s authority through child input COMMIT (system=%s)",
    async (boundary, system) => {
      await using fixture = await createHostedChildFixture({
        system,
        toolInvocation: boundary === "invocation",
      });
      fixture.beforeInputCommit.mockImplementation(
        boundary === "invocation" ? fixture.closeInvocation : fixture.closeParent,
      );
      const creating = fixture.send();
      if (boundary === "invocation") {
        await expect(creating).resolves.toMatchObject({
          ok: true,
          runStarted: false,
          runError: { code: "UNAVAILABLE", message: "Error: inherited tool invocation closed" },
        });
      } else {
        await expect(creating).rejects.toThrow(
          system
            ? "agent tool caller authority is no longer active"
            : "operator execution authority is no longer active",
        );
      }
      await expectNoInput(fixture);
    },
  );

  it.each(["source", "host", "signal", "gateway", "replacement"] as const)(
    "retains the original %s boundary after child ACK and parent closure",
    async (change) => {
      await using fixture = await createHostedChildFixture();
      const accepted = await fixture.send();
      const { scope, pending } = await expectQueued(fixture, accepted);
      fixture.closeParent();
      if (change === "replacement") {
        replaceSessionEntrySync(scope, { sessionId: "successor-child", updatedAt: Date.now() });
      } else {
        fixture.revoke[change]();
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
});
