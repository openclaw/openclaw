import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { getAdmittedRunDelegatedAuthority } from "../../agents/admitted-run-context.js";
import { captureActiveEmbeddedRunParticipation } from "../../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../../agents/harness/tool-authority.runtime.js";
import {
  admitted,
  attempt,
  sessionId,
  sessionKey,
} from "../../agents/harness/tool-authority.runtime.test-support.js";
import type { ParticipationCeiling } from "../../agents/participation-ceiling.js";
import { createParticipationTestAuthority } from "../../agents/participation-ceiling.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { buildApprovalResolutionRef } from "../../infra/approval-resolution-ref.js";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { testing as replyTesting } from "../../sessions/session-controller.test-support.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import {
  ensureCanonicalUserProfileForEmail,
  mergeCanonicalUserProfiles,
} from "../../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import {
  authorizeParticipationExecApprovalMethod,
  canResolveParticipationExecApproval,
  prepareExecApprovalParticipation,
} from "../exec-approval-participation.js";
import { createExpectedProfileBinding } from "../expected-profile.js";
import { captureQueuedOperatorRecoverySource } from "../operator-run-recovery-source.js";
import { createChatRunState } from "../server-chat-state.js";
import { createRequestGatewayMethodRegistry } from "../server-methods.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import { createApprovalHandlers } from "./approval.js";
import {
  createApprovalInvocation,
  createClient,
  createContext,
  getOperatorApproval,
} from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import { authorizeGatewayMethod } from "./method-authorization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const binding = { creatorProfileId: "creator", participantProfileId: "participant", sessionKey };
function handlersFor(
  method: string,
  fixture: Awaited<
    ReturnType<typeof createPreparedTestApprovalManager<ExecApprovalRequestPayload>>
  >,
) {
  const { manager, databaseOptions } = fixture;
  return method === "exec.approval.resolve"
    ? createExecApprovalHandlers(manager)
    : createApprovalHandlers({
        execApprovalManager: manager,
        pluginApprovalManager: new ExecApprovalManager<PluginApprovalRequestPayload>({
          approvalKind: "plugin",
          scheduler: createTestGatewayScheduler(),
          persistence: { runtimeEpoch: manager.runtimeEpoch, databaseOptions },
        }),
        databaseOptions,
      });
}
const methods = ["exec.approval.resolve", "approval.resolve"] as const;
function client(profileId: string, scopes: string[]) {
  const result = createClient({ scopes, deviceId: profileId });
  result.authenticatedUserProfile = {
    profileId,
    displayName: profileId,
    avatarRevision: "",
    hasAvatar: false,
    updatedAt: 1,
  };
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  testing.resetActiveEmbeddedRuns();
  replyTesting.resetSessionControllerForTest();
});

it.for(methods)(
  "%s permits only the bound direct creator or admin, preserving ordinary approvals",
  async (method, test) => {
    const fixture = await createPreparedTestApprovalManager(test);
    await fixture.run(async () => {
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const { manager } = fixture;
      const handlers = handlersFor(method, fixture);
      const record = manager.create(
        { command: "echo participation", agentId: "main", sessionKey },
        60_000,
      );
      record.participation = binding;
      record.requestedByDeviceId = "participant";
      record.approvalReviewerDeviceIds = ["participant", "assignee", "unrelated"];
      const registered = await manager.register(record, 60_000);
      const context = { ...createContext(), execApprovalManager: manager };
      const methodRegistry = createRequestGatewayMethodRegistry(handlers);
      const invoke = async (who: ReturnType<typeof client>, id = record.id) => {
        const body = {
          id,
          ...(method === "approval.resolve" ? { kind: "exec" } : {}),
          decision: "allow-once",
        };
        const admission = authorizeGatewayMethod(method, who, body, methodRegistry, context);
        if (admission.error) {
          return { ok: false, error: admission.error };
        }
        return createApprovalInvocation({
          handlers,
          method,
          body,
          client: who,
          context,
        }).invoke();
      };
      for (const name of ["participant", "assignee", "unrelated"]) {
        const who = client(name, ["operator.approvals"]);
        expect(
          authorizeParticipationExecApprovalMethod({
            method,
            params: { id: record.id },
            client: who,
            manager,
          }),
        ).toBe(false);
        expect((await invoke(who)).ok, name).toBe(false);
        // The compact transport reference reaches the same creator-only binding.
        const resolutionRef = buildApprovalResolutionRef({
          approvalId: record.id,
          approvalKind: "exec",
        });
        expect((await invoke(who, resolutionRef)).ok, `${name} by reference`).toBe(false);
        expect(record.resolvedAtMs).toBeUndefined();
      }
      const creator = client("creator", ["operator.read", "operator.write"]);
      expect(
        authorizeParticipationExecApprovalMethod({
          method,
          params: { id: record.id },
          client: creator,
          manager,
        }),
      ).toBe(true);
      expect(
        authorizeParticipationExecApprovalMethod({
          method,
          params: { id: record.id.slice(0, 8) },
          client: creator,
          manager,
        }),
      ).toBeUndefined();
      expect((await invoke(creator, record.id.slice(0, 8))).ok).toBe(false);
      expect((await invoke(creator, "unknown-approval")).ok).toBe(false);
      expect(
        getOperatorApproval({ id: record.id, databaseOptions: fixture.databaseOptions }),
      ).not.toHaveProperty("participation");
      const requesterRead = await createApprovalInvocation({
        handlers: createExecApprovalHandlers(manager),
        method: "exec.approval.get",
        body: { id: record.id },
        client: client("participant", ["operator.approvals"]),
      }).invoke();
      expect(requesterRead.ok).toBe(true);
      const synthetic = client("creator", ["operator.approvals"]);
      synthetic.internal = { approvalRuntime: true };
      expect((await invoke(synthetic)).ok).toBe(false);
      expect((await invoke(creator)).ok).toBe(true);
      await expect(registered.decision).resolves.toBe("allow-once");
      // A new browser connection for the same person can observe the same local winner.
      const reconnected = client("creator", ["operator.read", "operator.write"]);
      reconnected.connId = "reconnected-creator";
      expect((await invoke(reconnected)).ok).toBe(true);
      const adminRecord = manager.create({ command: "echo admin" }, 60_000);
      adminRecord.participation = binding;
      await manager.register(adminRecord, 60_000);
      expect((await invoke(client("admin", ["operator.admin"]), adminRecord.id)).ok).toBe(true);
      const ordinary = manager.create(
        { command: "echo ordinary", sessionKey, security: "allowlist", ask: "always" },
        60_000,
      );
      ordinary.requestedByDeviceId = "reviewer";
      ordinary.approvalReviewerDeviceIds = ["reviewer"];
      await manager.register(ordinary, 60_000);
      expect(
        authorizeParticipationExecApprovalMethod({
          method,
          params: { id: ordinary.id },
          client: creator,
          manager,
        }),
      ).toBeUndefined();
      expect((await invoke(creator, ordinary.id)).ok).toBe(false);
      expect((await invoke(client("reviewer", ["operator.approvals"]), ordinary.id)).ok).toBe(true);
    });
  },
);

it.for(methods)(
  "%s preserves the selected creator profile through the final mutation guard",
  async (method, test) => {
    const fixture = await createPreparedTestApprovalManager(test);
    await fixture.run(async () => {
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const { manager, databaseOptions } = fixture;
      const handlers = handlersFor(method, fixture);
      const creatorProfile = await ensureCanonicalUserProfileForEmail("creator@approval.test");
      const participantProfile = await ensureCanonicalUserProfileForEmail(
        "participant@approval.test",
      );
      const record = manager.create({ command: "echo guard" }, 60_000);
      record.participation = {
        ...binding,
        creatorProfileId: creatorProfile.id,
        participantProfileId: participantProfile.id,
      };
      await manager.register(record, 60_000);
      const creator = client(creatorProfile.id, ["operator.read", "operator.write"]);
      const expectedProfileBinding = await createExpectedProfileBinding(creatorProfile.id, creator);
      expectDefined(expectedProfileBinding, "creator profile binding").assertCurrent();
      const original = manager.resolveDetailed.bind(manager);
      vi.spyOn(manager, "resolveDetailed").mockImplementationOnce((...args) => {
        creator.authenticatedUserProfile = client(
          participantProfile.id,
          [],
        ).authenticatedUserProfile;
        return original(...args);
      });
      const response = await createApprovalInvocation({
        handlers,
        method,
        body: {
          id: record.id,
          ...(method === "approval.resolve" ? { kind: "exec" } : {}),
          decision: "allow-once",
        },
        client: creator,
        expectedProfileBinding,
      }).invoke();
      expect(response.ok).toBe(false);
      expect(getOperatorApproval({ id: record.id, databaseOptions })?.status).toBe("pending");
      expect(record.resolvedAtMs).toBeUndefined();
    });
  },
);

it.for(["direct", "child"] as const)(
  "binds %s request approvals to the original creator through registered host authority",
  async (kind, test) => {
    const fixture = await createPreparedTestApprovalManager(test);
    await fixture.run(() =>
      withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async (state) => {
        const creatorProfile = await ensureCanonicalUserProfileForEmail("creator@participate.test");
        const participant = await ensureCanonicalUserProfileForEmail(
          "participant@participate.test",
        );
        const runSessionKey = kind === "child" ? "agent:main:subagent:approval-child" : sessionKey;
        const runSessionId = kind === "child" ? "approval-child-id" : sessionId;
        const ceiling: ParticipationCeiling = {
          kind: "send",
          profileId: participant.id,
          sessionKey,
          source: {
            agentId: "main",
            sessionId,
            lifecycleRevision: null,
            creatorProfileId: creatorProfile.id,
            root: state.workspaceDir,
          },
        };
        const authority = createParticipationTestAuthority(ceiling);
        const expectedBinding = {
          ...binding,
          creatorProfileId: creatorProfile.id,
          ...(kind === "child" ? { creatorOnly: true as const } : {}),
          participantProfileId: participant.id,
          participantLabel: participant.displayName || participant.id,
        };
        const cfg = {
          agents: { entries: { main: {} } },
          gateway: {
            roles: {
              default: "invited",
              definitions: {
                invited: {
                  agents: "*" as const,
                  scopes: ["operator.read" as const, "operator.write" as const],
                  sessions: { others: "invited" as const },
                },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            sessionRoot: state.workspaceDir,
            createdActor: { type: "human", source: "profile", id: creatorProfile.id },
            owner: { actor: { type: "human", id: "assignee" } },
          },
        );
        if (kind === "child") {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: runSessionKey },
            {
              sessionId: runSessionId,
              updatedAt: 1,
              parentSessionKey: sessionKey,
              createdActor: { type: "human", source: "profile", id: participant.id },
              delegatedOperatorSource: captureQueuedOperatorRecoverySource(authority),
            },
          );
        }
        await admitted(async ({ admittedRunContext }) => {
          const delegated = expectDefined(
            getAdmittedRunDelegatedAuthority(admittedRunContext),
            "delegated run",
          );
          const identity: AgentRuntimeIdentity = {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: runSessionKey,
            operationalRunInstance: admittedRunContext.operationalRunInstance,
            delegatedAuthority: { ...delegated, kind: "local" },
          };
          const runtimeClient = {
            ...client(participant.id, ["operator.sessions.read"]),
            internal: { agentRuntimeIdentity: identity },
          };
          const authorize = (method: string, id?: string, who = runtimeClient) =>
            authorizeParticipationExecApprovalMethod({
              method,
              params: { id, sessionKey: runSessionKey, runId: attempt.runId },
              client: who,
              manager: fixture.manager,
            });
          expect(captureActiveEmbeddedRunParticipation(identity)).toBeUndefined();
          expect(authorize("exec.approval.request")).toBeUndefined();
          await withPreparedEmbeddedRunToolAuthority(
            { admittedRunContext },
            {
              ...attempt,
              sessionId: runSessionId,
              sessionKey: runSessionKey,
            },
            undefined,
            async (prepared) => {
              const handle = createEmbeddedRunHandle({
                runId: attempt.runId,
                toolAuthorityFingerprint: prepared.toolAuthorityFingerprint,
              });
              attachActiveEmbeddedRun(
                runSessionId,
                handle,
                runSessionKey,
                attempt.sessionFile,
                "main",
                prepared.replyOperation,
              );
              try {
                const capture = expectDefined(
                  captureActiveEmbeddedRunParticipation(identity),
                  "host capture",
                );
                expect(capture.ceiling).toEqual(authority.participationCeiling);
                expect(() =>
                  captureActiveEmbeddedRunParticipation({
                    ...identity,
                    delegatedAuthority: { ...identity.delegatedAuthority, claimId: "forged" },
                  }),
                ).toThrow();
                expect(await prepareExecApprovalParticipation(identity, {})).toEqual(
                  expectedBinding,
                );
                expect(authorize("exec.approval.request")).toBe(true);
                expect(authorize("exec.approval.waitDecision", "missing")).toBeUndefined();
                const forwarder = {
                  handleRequested: vi.fn(async () => true),
                  handleResolved: vi.fn(async () => undefined),
                  stop: vi.fn(async () => undefined),
                };
                const handlers = createExecApprovalHandlers(fixture.manager, { forwarder });
                const context = {
                  ...createContext(),
                  chatRunState: createChatRunState(),
                  validateAgentRuntimeApprovalAuthority:
                    createAgentRuntimeApprovalAuthorityValidator(),
                };
                const request = async (runtime: boolean) => {
                  const params = {
                    command: "echo proof",
                    host: "gateway",
                    timeoutMs: 60_000,
                    twoPhase: true,
                    agentId: "main",
                    sessionKey: runSessionKey,
                    runId: attempt.runId,
                    security: "allowlist",
                    ask: "always",
                  };
                  const opts: GatewayRequestHandlerOptions = {
                    req: { type: "req", id: "request", method: "exec.approval.request", params },
                    params,
                    context,
                    respond: vi.fn(),
                    isWebchatConnect: () => false,
                    client: runtime
                      ? {
                          ...client("runtime", ["operator.approvals"]),
                          internal: { agentRuntimeIdentity: identity },
                        }
                      : client("ordinary", ["operator.approvals"]),
                  };
                  const { pending } = await waitForApprovalRequested(
                    context,
                    "exec.approval.requested",
                    () => fixture.track(Promise.resolve(handlers["exec.approval.request"]!(opts))),
                  );
                  const record = expectDefined(
                    (await fixture.manager.listPendingRecords())[0],
                    "requested record",
                  );
                  expect(record.participation).toEqual(runtime ? expectedBinding : undefined);
                  // Only the creator's connections can resolve a participation approval.
                  expect(forwarder.handleRequested).toHaveBeenCalledTimes(runtime ? 0 : 1);
                  forwarder.handleRequested.mockClear();
                  expect(authorize("exec.approval.waitDecision", record.id)).toBe(
                    runtime ? true : undefined,
                  );
                  expect(
                    authorize("exec.approval.waitDecision", record.id.slice(0, 8)),
                  ).toBeUndefined();
                  for (const method of [
                    "exec.approval.get",
                    "exec.approval.list",
                    "plugin.approval.request",
                  ]) {
                    expect(authorize(method, record.id)).toBeUndefined();
                  }
                  if (runtime) {
                    expect(authorize("exec.approval.resolve", record.id)).toBe(false);
                    expect(authorize("approval.resolve", record.id)).toBe(false);
                    const foreign = {
                      ...runtimeClient,
                      internal: {
                        agentRuntimeIdentity: {
                          ...identity,
                          delegatedAuthority: { ...identity.delegatedAuthority, claimId: "forged" },
                        },
                      },
                    };
                    expect(() => authorize("exec.approval.request", undefined, foreign)).toThrow();
                    expect(() =>
                      authorize("exec.approval.waitDecision", record.id, foreign),
                    ).toThrow();
                    if (kind === "child") {
                      for (const method of methods) {
                        const invoke = (who: ReturnType<typeof client>) =>
                          createApprovalInvocation({
                            handlers: handlersFor(method, fixture),
                            context: { ...createContext(), getRuntimeConfig: () => cfg },
                            method,
                            body: {
                              id: record.id,
                              ...(method === "approval.resolve" ? { kind: "exec" } : {}),
                              decision: "allow-once",
                            },
                            client: who,
                          }).invoke();
                        const creator = client(creatorProfile.id, [
                          "operator.read",
                          "operator.write",
                        ]);
                        expect(canResolveParticipationExecApproval(record, creator)).toBe(true);
                        for (const who of [
                          client(participant.id, ["operator.approvals"]),
                          client("assignee", ["operator.approvals"]),
                          client("admin", ["operator.admin"]),
                        ]) {
                          expect((await invoke(who)).ok).toBe(false);
                          expect(record.resolvedAtMs).toBeUndefined();
                        }
                      }
                      expect(
                        (
                          await createApprovalInvocation({
                            handlers,
                            context: { ...createContext(), getRuntimeConfig: () => cfg },
                            method: "exec.approval.resolve",
                            body: { id: record.id, decision: "allow-once" },
                            client: client(creatorProfile.id, ["operator.read", "operator.write"]),
                          }).invoke()
                        ).ok,
                      ).toBe(true);
                    }
                  }
                  await fixture.manager.resolve(record.id, "deny", "cleanup");
                  await pending;
                };
                await request(true);
                await request(false);
                detachActiveEmbeddedRun(runSessionId, handle, runSessionKey);
                expect(() => capture.assertCurrent()).toThrow();
                expect(captureActiveEmbeddedRunParticipation(identity)).toBeUndefined();
                expect(authorize("exec.approval.request")).toBeUndefined();
              } finally {
                detachActiveEmbeddedRun(runSessionId, handle, runSessionKey);
              }
            },
          );
        }, authority);
      }),
    );
  },
);

it("recognizes a merged creator without letting a merged participant self-approve", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const original = await ensureCanonicalUserProfileForEmail("original@participate.test");
    const creator = await ensureCanonicalUserProfileForEmail("creator@participate.test");
    const participant = await ensureCanonicalUserProfileForEmail("participant@participate.test");
    const bound = {
      participation: {
        creatorProfileId: original.id,
        participantProfileId: participant.id,
        sessionKey,
      },
    };
    const caller = client(creator.id, ["operator.sessions.read"]);
    expect(canResolveParticipationExecApproval(bound, caller)).toBe(false);
    await mergeCanonicalUserProfiles(original.id, creator.id);
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    expect(canResolveParticipationExecApproval(bound, caller)).toBe(true);
    await mergeCanonicalUserProfiles(participant.id, creator.id);
    const participantProfiles = await prepareUserProfileCatalog();
    try {
      expect(canResolveParticipationExecApproval(bound, caller)).toBe(false);
    } finally {
      participantProfiles.release();
    }
  });
});
