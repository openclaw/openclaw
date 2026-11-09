import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/users.js";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { clearConfigCache, setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../../../config/types.gateway.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { normalizeAcceptedSessionSpawnResult as acceptedSpawn } from "../../accepted-session-spawn.js";
import {
  readAdmittedRunOperatorAuthority,
  readRunModelPolicy,
  assertOperatorModelAllowed,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { buildAgentInternalEventContext, type AgentInternalEvent } from "../../internal-events.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { restoreRequesterModelPolicySnapshot } from "../../operator-model-policy-state.js";
import { prepareOperatorModelPolicy } from "../../operator-model-policy.js";
import {
  captureGatewayToolCallerAssertion,
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { jsonResult } from "../../tools/tool-results.js";
import { ensureAgentWorkspace } from "../../workspace.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  activateSubagentRegistry,
  settleRequesterAfterSessionSpawns,
} from "../registry/subagent-registry.js";
import { admitEmbeddedRun, recordFinal } from "./subagent-spawn.boundary-run.test-support.js";
import {
  collectFailure,
  sessionReader,
  visibleResult,
  type BoundaryHarness,
  type WaitForEmbeddedRun,
} from "./subagent-spawn.fixtures.test-support.js";
import {
  createBoundSpawnInvocation,
  createSpawnOperatorSource,
  type NativePluginSpawnTestOptions,
  type RequestCustodySpawnCaseOptions,
} from "./subagent-spawn.production-boundary.test-support.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

type Source = ReturnType<typeof createSpawnOperatorSource>;
type BoundParent = Awaited<ReturnType<RequestCustodySpawnCaseOptions["createBoundParent"]>>;
const hiddenSpawn = { visible: false, context: "isolated", completionTarget: "parent" } as const;

export function createGuestParentFixture(options: {
  getRuntimeConfig: () => OpenClawConfig;
  setRuntimeConfig: (cfg: OpenClawConfig) => void;
  writeConfig: (cfg: OpenClawConfig) => Promise<unknown>;
  setProfileCatalogRelease: (
    release: Awaited<ReturnType<typeof prepareUserProfileCatalog>>["release"],
  ) => void;
  createBoundParent: (
    authority: Source["authority"],
    options?: { guestProfileId?: string },
  ) => Promise<BoundParent>;
}) {
  return async function createGuestParent(
    audit = true,
    scopes: NonNullable<GatewayOperatorRoleDefinition["scopes"]> = ["operator.sessions.write"],
    bounded = true,
  ) {
    let runtimeConfig = options.getRuntimeConfig();
    const guestRole = {
      scopes,
      agents: ["main"],
      sessions: { others: "none" },
      sandbox: "required",
    } satisfies GatewayOperatorRoleDefinition;
    runtimeConfig = {
      ...runtimeConfig,
      logging: { audit: { enabled: audit, executionIdentity: audit } },
      gateway: { roles: { default: "guest", definitions: { guest: guestRole } } },
    };
    options.setRuntimeConfig(runtimeConfig);
    await options.writeConfig(runtimeConfig);
    clearConfigCache();
    setRuntimeConfigSnapshot(runtimeConfig);
    const modelPolicy = bounded
      ? prepareOperatorModelPolicy({
          cfg: runtimeConfig,
          policy: { sourceAgent: "main", allow: ["custom/test-model"] },
        })
      : undefined;
    const guest = ensureProfileForEmail("spawn-guest@example.test");
    options.setProfileCatalogRelease((await prepareUserProfileCatalog()).release);
    const source = createSpawnOperatorSource(guest.id, guestRole.scopes, {
      modelPolicy,
      rolePolicy: { sessionAccessCap: "none", sandboxRequired: true, agents: ["main"] },
      readCurrentRoleFacts: () => ({ assignedRole: "guest" }),
    });
    const bound = await options.createBoundParent(source.authority, {
      guestProfileId: source.authority.profileId,
    });
    expect(sessionReader(bound.storePath)(bound.parentSessionKey)).toMatchObject({
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: source.authority.profileId },
    });
    return { bound, source, modelPolicy, scopes: guestRole.scopes };
  };
}

export function registerGuestSpawnCases(
  options: BoundaryHarness & {
    createGuestParent: (
      audit?: boolean,
      scopes?: NonNullable<GatewayOperatorRoleDefinition["scopes"]>,
      bounded?: boolean,
    ) => Promise<{
      bound: BoundParent;
      source: Source;
      modelPolicy: Source["authority"]["modelPolicy"];
      scopes: string[];
    }>;
    createBoundParent: NativePluginSpawnTestOptions["createBoundParent"];
    waitForEmbeddedRun: WaitForEmbeddedRun;
    getRuntimeConfig: () => OpenClawConfig;
    setRuntimeConfig: (cfg: OpenClawConfig) => void;
  },
) {
  it.each(["automatic", "explicit"] as const)(
    "selects policy-adjusted automatic defaults without allowing forbidden explicit overrides (%s)",
    async (selection) => {
      const runtimeConfig = options.getRuntimeConfig();
      options.setRuntimeConfig({
        ...runtimeConfig,
        agents: {
          ...runtimeConfig.agents,
          defaults: {
            ...runtimeConfig.agents?.defaults,
            model: { primary: "custom/forbidden-model", fallbacks: ["custom/test-model"] },
          },
        },
      });
      const { bound, source } = await options.createGuestParent(false, [
        "operator.write",
        "operator.sessions.write",
      ]);
      const { context, runtime } = await options.createBoundGateway(bound);
      const targetKey = "agent:main:policy-adjusted-default";
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: targetKey },
        {
          sessionId: "policy-adjusted-default",
          sandbox: "required",
          createdActor: { type: "human", source: "profile", id: source.authority.profileId },
        },
      );
      const caller = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          agentId: "main",
          sessionKey: bound.parentSessionKey,
          admittedRunContext: bound.admitted,
        }),
        "guest caller",
      );
      options.runEmbeddedAgent.mockImplementation(async (params) => {
        await admitEmbeddedRun(params);
        await params.onExecutionStarted?.();
        await recordFinal(bound, params, "Allowed automatic model completed.");
        return visibleResult("Allowed automatic model completed.");
      });
      const invoke = () =>
        withGatewayToolCallerIdentity(caller, () =>
          withPluginRuntimeGatewayRequestScope(
            {
              context,
              resolveGatewayContext: bound.resolveGatewayContext,
              isWebchatConnect: () => false,
            },
            async () => {
              const dispatch = {
                context,
                isWebchatConnect: () => false,
                resolveGatewayContext: bound.resolveGatewayContext,
                allowSyntheticModelOverride: true,
              };
              const accepted = await dispatchGatewayMethodInProcess<{ runId: string }>(
                "agent",
                {
                  sessionKey: targetKey,
                  message: "Use the allowed automatic model.",
                  idempotencyKey: "policy-adjusted-" + selection,
                  ...(selection === "explicit" ? { model: "custom/forbidden-model" } : {}),
                },
                dispatch,
              );
              return await dispatchGatewayMethodInProcess<unknown>(
                "agent.wait",
                {
                  runId: accepted.runId,
                  timeoutMs: 30_000,
                },
                dispatch,
              );
            },
          ),
        );
      try {
        // An accepted agent receipt is not completion; observe the owning runtime's terminal result.
        const result = await invoke().catch((error: unknown) => ({
          status: "error",
          error: String(error),
        }));
        if (selection === "explicit") {
          expect(result).toMatchObject({ status: "error" });
          expect(JSON.stringify(result)).toContain("cannot use this model");
          expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        } else {
          expect(result).toMatchObject({ status: "ok" });
          expect(options.runEmbeddedAgent).toHaveBeenCalledOnce();
          expect(options.runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
            provider: "custom",
            model: "test-model",
          });
        }
      } finally {
        const failures = await options.closeBoundGateway(bound, runtime);
        source.closeRequest();
        options.throwBoundFailures(failures);
      }
    },
  );

  it.for([
    {
      audit: false,
      visibility: "shared",
      context: "isolated",
      visible: false,
      bounded: true,
      independent: false,
    },
    {
      audit: true,
      visibility: "shared",
      context: "isolated",
      visible: false,
      bounded: true,
      independent: false,
    },
    {
      audit: false,
      visibility: "draft",
      context: "isolated",
      visible: false,
      bounded: true,
      independent: false,
    },
    {
      audit: false,
      visibility: "draft",
      context: "fork",
      visible: false,
      bounded: true,
      independent: false,
    },
    {
      audit: false,
      visibility: "shared",
      context: "isolated",
      visible: true,
      bounded: false,
      independent: false,
    },
    {
      audit: false,
      visibility: "shared",
      context: "isolated",
      visible: true,
      bounded: true,
      independent: false,
    },
    {
      audit: false,
      visibility: "shared",
      context: "fork",
      visible: true,
      bounded: true,
      independent: false,
    },
    {
      audit: false,
      visibility: "shared",
      context: "isolated",
      visible: false,
      bounded: true,
      independent: true,
    },
  ] as const)(
    "launches an owned $visibility child and returns its result (audit=$audit, context=$context, visible=$visible, bounded=$bounded, independent=$independent)",
    async ({ audit, visibility, context, visible, bounded, independent }, { signal }) => {
      const { bound, source, modelPolicy, scopes } =
        visible || independent
          ? await (async () => {
              // Visible sessions use chat initialization before their agent-RPC continuation.
              await ensureAgentWorkspace({
                dir: expectDefined(
                  options.getRuntimeConfig().agents?.defaults?.workspace,
                  "configured fixture workspace",
                ),
                ensureBootstrapFiles: true,
              });
              const requestedModelPolicy = bounded
                ? prepareOperatorModelPolicy({
                    cfg: options.getRuntimeConfig(),
                    policy: { sourceAgent: "main", allow: ["custom/test-model"] },
                  })
                : undefined;
              const catalog = await prepareUserProfileCatalog();
              onTestFinished(catalog.release);
              const ownerSource = createSpawnOperatorSource(
                GATEWAY_OWNER_PROFILE_ID,
                ["operator.admin"],
                {
                  modelPolicy: independent ? undefined : requestedModelPolicy,
                },
              );
              const ownerParent = await options.createBoundParent(
                independent ? undefined : ownerSource.authority,
                { modelPolicy: independent ? requestedModelPolicy : undefined },
              );
              if (independent) {
                expect(ownerParent.admitted.modelPolicy).toBe(requestedModelPolicy);
              }
              return {
                bound: ownerParent,
                source: ownerSource,
                modelPolicy: requestedModelPolicy,
                scopes: ownerSource.authority.scopes,
              };
            })()
          : await options.createGuestParent(audit, undefined, bounded);
      if (!visible) {
        await upsertSessionEntryCore(
          { storePath: bound.storePath, sessionKey: bound.parentSessionKey },
          { visibility },
        );
      }
      const readSession = sessionReader(bound.storePath);
      if (context === "fork") {
        const parent = expectDefined(readSession(bound.parentSessionKey), "fork parent");
        for (const message of [
          { role: "user", content: "Plan a small picnic." },
          { role: "assistant", content: "Let us compare indoor backups.", stopReason: "stop" },
        ]) {
          await appendTranscriptMessage(
            {
              storePath: bound.storePath,
              sessionKey: bound.parentSessionKey,
              sessionId: parent.sessionId,
            },
            { message },
          );
        }
      }
      const { runtime } = await options.createBoundGateway(bound);
      vi.mocked(runtime.lifecycle.waitForAgent).mockRestore();
      await activateSubagentRegistry(bound.resolveGatewayContext);
      const nativeAnnounce = await vi.importActual<
        typeof import("../announce/subagent-announce.js")
      >("../announce/subagent-announce.js");
      const delivered = createDeferred<Awaited<ReturnType<typeof runSubagentAnnounceFlow>>>();
      vi.mocked(runSubagentAnnounceFlow).mockImplementation((params) => {
        const result = nativeAnnounce.runSubagentAnnounceFlow(params);
        void result.then(delivered.resolve, delivered.reject);
        return result;
      });
      const started = createDeferred();
      const modelResult = createDeferred<EmbeddedAgentRunResult>();
      const parentTurns: { prompt: string; internalEvents?: AgentInternalEvent[] }[] = [];
      options.runEmbeddedAgent.mockImplementation(async (params) => {
        const admitted = await admitEmbeddedRun(params);
        const authority = readAdmittedRunOperatorAuthority(admitted);
        if (params.sessionKey === bound.parentSessionKey) {
          if (bounded) {
            const ceiling = expectDefined(admitted.modelPolicy, "resumed parent own model ceiling");
            expect(ceiling.allows({ provider: "custom", model: "test-model" })).toBe(true);
            // Native System principal authority is legitimate, but cannot substitute for the saved ceiling.
            for (const currentAuthority of [undefined, authority]) {
              expect(() =>
                assertOperatorModelAllowed(
                  currentAuthority,
                  {
                    provider: "custom",
                    model: "forbidden-model",
                  },
                  ceiling,
                ),
              ).toThrow("cannot use this model");
            }
          } else {
            expect(admitted.modelPolicy).toBeUndefined();
          }
        } else {
          if (!visible && !independent) {
            expect(authority?.profileId).toBe(source.authority.profileId);
            expect(authority?.scopes).toEqual(scopes);
            expect(authority?.modelPolicy).toBe(independent ? undefined : modelPolicy);
          }
          if (independent) {
            expect(authority?.modelPolicy).toBeUndefined();
          }
          if (bounded) {
            const childCeiling = independent
              ? expectDefined(admitted.modelPolicy, "initial child own model ceiling")
              : readRunModelPolicy({ admittedRunContext: admitted });
            expect(childCeiling?.allows({ provider: "custom", model: "test-model" })).toBe(true);
            expect(() =>
              assertOperatorModelAllowed(
                undefined,
                { provider: "custom", model: "forbidden-model" },
                childCeiling,
              ),
            ).toThrow("cannot use this model");
          }
        }
        await params.onExecutionStarted?.();
        const parentTurn = params.sessionKey === bound.parentSessionKey;
        if (parentTurn) {
          parentTurns.push({ prompt: params.prompt, internalEvents: params.internalEvents });
        } else {
          started.resolve();
        }
        const text = parentTurn ? "Parent received the result" : "guest child complete";
        const result = parentTurn ? visibleResult(text) : await modelResult.promise;
        await recordFinal(bound, params, text);
        return result;
      });
      let childRunId: string | undefined;
      let initialChildVisibility: string | undefined;
      const failures: unknown[] = [];
      await collectFailure(failures, async () => {
        const result = visible
          ? await withPluginRuntimeGatewayRequestScope(
              {
                context: bound.resolveGatewayContext(),
                resolveGatewayContext: bound.resolveGatewayContext,
                isWebchatConnect: () => false,
              },
              () =>
                withGatewayToolCallerIdentity(
                  createAdmittedGatewayToolCallerIdentity({
                    agentId: "main",
                    sessionKey: bound.parentSessionKey,
                    admittedRunContext: bound.admitted,
                    requesterOrigin: {
                      sessionKey: bound.parentSessionKey,
                      operatorProfileId: source.authority.profileId,
                    },
                  }),
                  async () =>
                    jsonResult(
                      expectDefined(
                        await maybeSpawnVisibleSession({
                          raw: { visible: true, cleanup: "keep", context },
                          task: "bounded child",
                          taskName: "kept_result_worker",
                          label: "visible-kept-policy",
                          runtime: "subagent",
                          sandbox: "inherit",
                          expectsCompletionMessage: true,
                          options: {
                            config: bound.cfg,
                            agentSessionKey: bound.parentSessionKey,
                            requesterRunId: bound.parentRunId,
                            requesterTurnRunId: bound.parentRunId,
                            assertActive: expectDefined(
                              captureGatewayToolCallerAssertion(),
                              "active requester",
                            ),
                          },
                        }),
                        "visible producer result",
                      ),
                    ),
                ),
            )
          : await createBoundSpawnInvocation(bound, { ...hiddenSpawn, context })();
        const details = expectDefined(
          acceptedSpawn(result),
          `accepted child: ${JSON.stringify(result.details)}`,
        );
        childRunId = details.runId;
        await options.waitForEmbeddedRun(bound, details.runId, started.promise);
        expect(readSession(details.childSessionKey)).toMatchObject({
          spawnedBy: bound.parentSessionKey,
          createdActor: independent
            ? { type: "agent", id: "main" }
            : visible
              ? {
                  type: "agent",
                  id: "main",
                  delegatedBy: { type: "human", id: source.authority.profileId },
                }
              : {
                  type: "human",
                  source: "profile",
                  id: source.authority.profileId,
                  delegatedBy: { type: "human", source: "profile", id: source.authority.profileId },
                },
          ...(!visible && !independent ? { sandbox: "required" } : {}),
        });
        const stored = expectDefined(
          loadSubagentRegistryFromSqlite().get(details.runId),
          "durable requester ceiling",
        );
        expect(stored.requesterModelPolicySnapshot?.kind).toBe(bounded ? "bounded" : "unbounded");
        const restoredCeiling = restoreRequesterModelPolicySnapshot(
          stored.requesterModelPolicySnapshot,
        );
        if (bounded) {
          expect(() =>
            assertOperatorModelAllowed(
              undefined,
              { provider: "custom", model: "forbidden-model" },
              restoredCeiling,
            ),
          ).toThrow("cannot use this model");
        } else {
          expect(restoredCeiling).toBeUndefined();
        }
        initialChildVisibility = readSession(details.childSessionKey)?.visibility ?? "shared";
        expect(
          await settleRequesterAfterSessionSpawns({
            requesterSessionKey: bound.parentSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: bound.parentRunId,
            requesterYielded: false,
            acceptedSessionSpawns: [details],
          }),
        ).toBe(true);
        bound.admission.close();
        bound.parent.cleanup();
        source.closeRequest();
        modelResult.resolve(visibleResult("guest child complete"));
        expect(await withinTest(delivered.promise, signal)).toBe("delivered");
        expect(parentTurns).toHaveLength(1);
        expect(parentTurns[0]?.prompt).toContain(RUNTIME_EVENT_USER_PROMPT);
        expect(buildAgentInternalEventContext(parentTurns[0]?.internalEvents)).toContainEqual({
          kind: "conversation-data",
          text: expect.stringContaining("guest child complete"),
        });
      });
      modelResult.resolve(visibleResult("guest child complete"));
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      options.throwBoundFailures(failures);
      expect(initialChildVisibility).toBe(visible ? "shared" : visibility);
    },
  );

  it.each(["foreign target", "serialized request", "replaced child", "revoked source"] as const)(
    "rejects a guest hidden launch after %s without affecting another session",
    async (change) => {
      const { bound, source } = await options.createGuestParent(false);
      const readSession = sessionReader(bound.storePath);
      const { runtime } = await options.createBoundGateway(bound);
      const foreignKey = "agent:main:foreign-session";
      await upsertSessionEntryCore(
        { storePath: bound.storePath, sessionKey: foreignKey },
        {
          sessionId: "foreign-session",
          createdActor: { type: "human", source: "profile", id: "other-person" },
          sandbox: "required",
        },
      );
      let childKey: string | undefined;
      const failures: unknown[] = [];
      spawnTesting.setDepsForTest({
        dispatchGatewayMethodInProcess: async <T>(
          method: string,
          params: Record<string, unknown>,
          dispatchOptions?: Parameters<typeof dispatchGatewayMethodInProcess>[2],
        ) => {
          if (method === "agent") {
            childKey = String(params.sessionKey);
            if (change === "foreign target") {
              params.sessionKey = foreignKey;
            }

            if (change === "revoked source") {
              source.revoke();
            }
            if (change === "replaced child") {
              await upsertSessionEntryCore(
                { storePath: bound.storePath, sessionKey: childKey },
                { lifecycleRevision: "successor-lifecycle" },
              );
            }
          }
          return await dispatchGatewayMethodInProcess<T>(
            method,
            change === "serialized request" ? { ...params } : params,
            dispatchOptions,
          );
        },
      });
      await collectFailure(failures, async () => {
        const result = await createBoundSpawnInvocation(bound, hiddenSpawn)();
        expect(result.details).toMatchObject({ status: "error" });
        expect(options.runEmbeddedAgent).not.toHaveBeenCalled();
        const child = readSession(expectDefined(childKey, "created child"));
        if (change === "replaced child") {
          expect(child).toMatchObject({ lifecycleRevision: "successor-lifecycle" });
        } else {
          expect(child).toBeUndefined();
        }
        expect(readSession(foreignKey)).toMatchObject({
          sessionId: "foreign-session",
          createdActor: { id: "other-person" },
        });
        expect(readSession(bound.parentSessionKey)).toMatchObject({ sessionId: "parent-session" });
      });
      spawnTesting.setDepsForTest();
      failures.push(...(await options.closeBoundGateway(bound, runtime)));
      options.throwBoundFailures(failures);
    },
  );
}
