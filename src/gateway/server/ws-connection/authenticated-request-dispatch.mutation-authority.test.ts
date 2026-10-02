import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertOperatorModelAllowed,
  readAdmittedRunOperatorAuthority,
} from "../../../agents/admitted-run-context.js";
import { prepareChannelRunAdmission } from "../../../auto-reply/reply/channel-run-admission.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "../../../auto-reply/reply/queue.js";
import {
  createQueueSettings,
  createQueueTestRun,
} from "../../../auto-reply/reply/queue.test-helpers.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
} from "../../../auto-reply/reply/queue/lifecycle.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../../auto-reply/reply/queue/state.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { prepareUserProfileSelectionAuthority } from "../../../state/user-channel-identity-operations.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../../auth-policy.js";
import { publishOperatorRoleConfigChange } from "../../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  SharedGatewaySessionGenerationState,
} from "../../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

vi.mock("../../../state/user-channel-identity-operations.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/user-channel-identity-operations.js")>()),
  prepareUserProfileSelectionAuthority: vi.fn(),
}));
vi.mock("../../session-sharing.js", async () => ({
  // The probe has no session target; its request and selection owners remain real.
  resolveSessionMutationAuthorization: vi.fn(() => ({ error: null })),
  SessionMutationAuthorizationChangedError: (
    await import("../../session-mutation-authorization-error.js")
  ).SessionMutationAuthorizationChangedError,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetGatewayWorkAdmission();
});

afterEach(() => clearRuntimeConfigSnapshot());

describe("authenticated request mutation custody", () => {
  it("keeps original wildcard model ceilings separate through WS capture and contiguous collect", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const profile = ensureProfileForEmail("queued-model-ceiling@example.test");
      const modelA = { provider: "fixture", model: "family-a" };
      const modelB = { provider: "fixture", model: "family-b" };
      let committedConfig: OpenClawConfig = {
        agents: { defaults: { model: "fixture/family-a" } },
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.admin"],
                modelPolicy: { allow: ["fixture/family-*"] },
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(committedConfig);
      const client = createOperatorWsClient();
      client.authPolicy = captureGatewayAuthPolicy(committedConfig, null);
      client.internal = { operatorRoleActor: { kind: "operator", profileId: profile.id } };
      const context = createDirectChatContext({
        getRuntimeConfig: () => committedConfig,
        getCommittedRuntimeConfig: () => committedConfig,
      });
      context.resolveGatewayContext = () => context;
      const captures: NonNullable<
        Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>
      >[] = [];
      const harness = createDispatchTestHarness({
        buildRequestContext: () => context,
        extraHandlers: {
          "test.model-ceiling": async (options) => {
            const current = expectDefined(options.hasCurrentClientAuthority, "WS caller guard");
            captures.push(
              expectDefined(
                await captureGatewayOperatorRunAuthority({
                  client: options.client,
                  context,
                  hasCurrentClientAuthority: current,
                }),
                "captured operator source",
              ),
            );
            options.respond(true, { accepted: true });
          },
        },
      });
      const capture = async (id: string) => {
        await harness.dispatcher.dispatch(
          { type: "req", id, method: "test.model-ceiling", params: {} },
          client,
        );
        expect(harness.send).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: "res", id, ok: true }),
        );
        return expectDefined(captures.at(-1), "accepted request capture").authority;
      };
      const setPolicy = (allow: string[]) => {
        committedConfig = structuredClone(committedConfig);
        const role = expectDefined(committedConfig.gateway?.roles?.definitions.guest, "guest role");
        role.modelPolicy = { allow };
        setRuntimeConfigSnapshot(committedConfig);
        publishOperatorRoleConfigChange(context);
      };
      const key = "test-ws-original-model-ceilings";
      const observed: Array<{ prompts: string[] | null; allowsB: boolean }> = [];
      const failures: unknown[] = [];
      try {
        const wide = await capture("wide-first");
        setPolicy(["fixture/family-*"]);
        const compatible = await capture("wide-second");
        expect(wide.modelPolicy?.models).toEqual([modelA]);
        expect(() => assertOperatorModelAllowed(wide, modelB)).not.toThrow();
        setPolicy(["fixture/family-a"]);
        const narrow = await capture("narrow");
        setPolicy(["fixture/family-*"]);
        expect(narrow.modelPolicy?.models).toEqual(wide.modelPolicy?.models);
        expect(() => assertOperatorModelAllowed(narrow, modelB)).toThrow("operator role");
        const runs = [wide, compatible, narrow, wide].map((operatorAuthority, index) => {
          const run = createQueueTestRun({
            prompt: `request ${index}`,
            originatingChannel: "webchat",
          });
          run.operatorAuthority = operatorAuthority;
          run.run.provider = modelA.provider;
          run.run.model = modelA.model;
          return run;
        });
        for (const run of runs) {
          expect(enqueueFollowupRun(key, run, createQueueSettings())).toBe(true);
        }
        for (const retained of captures) {
          retained.release();
        }
        vi.useFakeTimers();
        scheduleFollowupDrain(key, async (run) => {
          const prepared = prepareChannelRunAdmission({
            cfg: committedConfig,
            runId: `queued-model-ceiling-${observed.length}`,
            agentId: "main",
            ingressKind: "channel",
            boundary: "auto-reply.agent-runner",
            operatorAuthority: run.operatorAuthority,
          });
          try {
            await admitFollowupRunLifecycle(run);
            const admitted = await prepared.admit("embedded");
            const authority = readAdmittedRunOperatorAuthority(admitted);
            assertOperatorModelAllowed(authority, modelA);
            observed.push({
              prompts: run.prompt.match(/request \d/g),
              allowsB: authority?.modelPolicy?.allows(modelB) === true,
            });
          } catch (error) {
            failures.push(error);
          } finally {
            prepared.close();
            completeFollowupRunLifecycle(run);
          }
        });
        await vi.runAllTimersAsync();
        expect(failures).toEqual([]);
        expect(getExistingFollowupQueue(key)).toBeUndefined();
        expect(observed).toEqual([
          { prompts: ["request 0", "request 1"], allowsB: true },
          { prompts: ["request 2"], allowsB: false },
          { prompts: ["request 3"], allowsB: true },
        ]);
      } finally {
        clearFollowupQueue(key);
        for (const retained of captures) {
          retained.release();
        }
        vi.useRealTimers();
      }
    });
  });

  it("fences stale requests without revoking retained work until its committed grant changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const identity = "retained@example.test";
      const profile = ensureProfileForEmail(identity);
      let committedConfig: OpenClawConfig = {
        gateway: {
          auth: {
            identityScopes: {
              [identity]: ["operator.admin"],
              "other@example.test": ["operator.read"],
            },
          },
        },
      };
      setRuntimeConfigSnapshot(committedConfig);
      const client = createOperatorWsClient();
      client.authenticatedUserId = identity;
      client.authPolicy = captureGatewayAuthPolicy(committedConfig, {
        role: "operator",
        verifiedIdentity: identity,
      });
      client.internal = { operatorRoleActor: { kind: "operator", profileId: profile.id } };
      const context = createDirectChatContext({
        getRuntimeConfig: () => committedConfig,
        getCommittedRuntimeConfig: () => committedConfig,
      });
      context.resolveGatewayContext = () => context;
      let captured: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      let guard: ReturnType<typeof readGatewayRequestMutationAuthority> | undefined;
      const generation = new SharedGatewaySessionGenerationState({
        current: undefined,
        required: null,
      });
      const harness = createDispatchTestHarness({
        buildRequestContext: () => context,
        getRequiredSharedGatewaySessionGeneration: generation.reader,
        extraHandlers: {
          "test.identity-scopes": async (options) => {
            captured = await captureGatewayOperatorRunAuthority({
              client: options.client,
              context,
              hasCurrentClientAuthority: options.hasCurrentClientAuthority,
            });
            guard = readGatewayRequestMutationAuthority(options);
            options.respond(true, { accepted: true });
          },
        },
      });
      try {
        await harness.dispatcher.dispatch(
          { type: "req", id: "identity-scopes", method: "test.identity-scopes", params: {} },
          client,
        );
        expect(harness.send).toHaveBeenLastCalledWith(
          expect.objectContaining({ ok: true, payload: { accepted: true } }),
        );
        const { authority } = expectDefined(captured, "captured operator source");
        const mutationGuard = expectDefined(guard, "request mutation guard");
        assert(mutationGuard.family === "worker");

        committedConfig = structuredClone(committedConfig);
        committedConfig.gateway!.auth!.identityScopes!["other@example.test"] = ["operator.admin"];
        setRuntimeConfigSnapshot(committedConfig);
        publishOperatorRoleConfigChange(context);
        expect(authority.signal?.aborted).toBe(false);
        expect(() => authority.assertCurrent()).not.toThrow();
        expect(() => mutationGuard.assertWorkerCurrent()).not.toThrow();
        expect(harness.close).not.toHaveBeenCalled();

        committedConfig = structuredClone(committedConfig);
        committedConfig.gateway!.trustedProxies = ["192.0.2.10"];
        setRuntimeConfigSnapshot(committedConfig);
        await harness.dispatcher.dispatch(
          { type: "req", id: "transport-fenced", method: "test.identity-scopes", params: {} },
          client,
        );
        expect(harness.close).toHaveBeenCalledWith(
          4001,
          "client invalidated: gateway-policy-changed",
        );
        expect(client).toMatchObject({ sourceInvalidated: false });
        expect(authority.signal?.aborted).toBe(false);
        expect(authority.assertCurrent).not.toThrow();

        committedConfig = structuredClone(committedConfig);
        delete committedConfig.gateway!.auth!.identityScopes![identity];
        setRuntimeConfigSnapshot(committedConfig);
        await harness.dispatcher.dispatch(
          { type: "req", id: "grant-revoked", method: "test.identity-scopes", params: {} },
          client,
        );
        expect(client).toMatchObject({ sourceInvalidated: true });
        expect(authority.signal?.aborted).toBe(true);
        expect(() => authority.assertCurrent()).toThrow(/authority is no longer active/);
        expect(() => mutationGuard.assertWorkerCurrent()).toThrow(
          /Gateway requester authority changed/,
        );
      } finally {
        captured?.release();
      }
    });
  });

  it.each(["commit", "rollback", "revoke all", "policy commit", "policy rollback"] as const)(
    "retains the accepted source through tentative transport fencing until %s",
    async (outcome) => {
      const generation = new SharedGatewaySessionGenerationState({
        current: "generation-a",
        required: null,
      });
      let committedConfig: OpenClawConfig = { gateway: { auth: { allowTailscale: true } } };
      const nextConfig: OpenClawConfig = { gateway: { auth: { allowTailscale: false } } };
      const changesPolicy = outcome === "policy commit" || outcome === "policy rollback";
      setRuntimeConfigSnapshot(committedConfig);
      const connection = new AbortController();
      const access = new AbortController();
      const client = createOperatorWsClient({
        socket: { close: () => connection.abort() },
      });
      client.usesSharedGatewayAuth = true;
      client.sharedGatewaySessionGeneration = "generation-a";
      client.authPolicy = captureGatewayAuthPolicy(committedConfig, {
        role: "operator",
        authMethod: "tailscale",
      });
      client.connectionSignal = connection.signal;
      client.internal = {
        operatorRoleActor: {
          kind: "operator",
          profileId: ensureProfileForEmail("transport-owner@example.test").id,
        },
      };
      const context = createDirectChatContext({
        getRuntimeConfig: () => getRuntimeConfigSnapshot() ?? committedConfig,
        getCommittedRuntimeConfig: () => committedConfig,
      });
      context.resolveGatewayContext = () => context;
      let captured: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
      const handler = vi.fn<(options: GatewayRequestHandlerOptions) => Promise<void>>(
        async (options) => {
          captured = await captureGatewayOperatorRunAuthority({
            client: options.client,
            context,
            hasCurrentClientAuthority: options.hasCurrentClientAuthority,
            sourceAuthority: {
              assertCurrent: () => access.signal.throwIfAborted(),
              signal: access.signal,
            },
          });
          options.respond(true, { accepted: true });
        },
      );
      const harness = createDispatchTestHarness({
        getRequiredSharedGatewaySessionGeneration: generation.reader,
        buildRequestContext: () => context,
        extraHandlers: { "test.source-custody": handler },
      });
      harness.close.mockImplementation(() => connection.abort());
      const dispatch = (id: string) =>
        harness.dispatcher.dispatch(
          { type: "req", id, method: "test.source-custody", params: {} },
          client,
        );
      await dispatch("accepted-source");
      const accepted = expectDefined(captured, "accepted source");
      const releaseQueued = expectDefined(accepted.authority.retain, "source retention")();
      accepted.release();
      try {
        let ownership = generation.capture();
        if (changesPolicy) {
          setRuntimeConfigSnapshot(nextConfig);
        } else {
          ownership = expectDefined(
            generation.claim(ownership, "generation-b"),
            "candidate generation owner",
          );
          disconnectStaleSharedGatewayAuthClients({
            state: generation,
            clients: [client],
            expectedGeneration: "generation-b",
            revokeSource: false,
          });
        }
        await dispatch("buffered-after-fence");
        expect(connection.signal.aborted).toBe(true);
        expect(handler).toHaveBeenCalledOnce();
        publishOperatorRoleConfigChange({});
        expect(accepted.authority.signal?.aborted).toBe(false);
        expect(() => accepted.authority.assertCurrent()).not.toThrow();

        if (outcome === "commit") {
          expect(generation.finalize(ownership)).toBe(true);
          expect(accepted.authority.signal?.aborted).toBe(true);
        } else if (outcome === "revoke all") {
          disconnectStaleSharedGatewayAuthClients({
            state: generation,
            clients: [],
            expectedGeneration: null,
          });
          expect(accepted.authority.signal?.aborted).toBe(true);
        } else if (outcome === "policy commit") {
          committedConfig = nextConfig;
          publishOperatorRoleConfigChange(context);
          expect(accepted.authority.signal?.aborted).toBe(true);
        } else {
          if (changesPolicy) {
            setRuntimeConfigSnapshot(committedConfig);
            publishOperatorRoleConfigChange(context);
          } else {
            expect(
              generation.replace(ownership, {
                current: "generation-a",
                required: null,
              }),
            ).toBe(true);
            // The original connection has left the socket set; rollback preserves its old source.
            disconnectStaleSharedGatewayAuthClients({
              state: generation,
              clients: [],
              expectedGeneration: "generation-a",
            });
          }
          expect(accepted.authority.signal?.aborted).toBe(false);
          expect(() => accepted.authority.assertCurrent()).not.toThrow();
          access.abort(new Error("original access source revoked"));
          expect(accepted.authority.signal?.aborted).toBe(true);
        }
      } finally {
        releaseQueued();
        accepted.release();
      }
    },
  );

  it.each([
    "transport retirement",
    "client invalidated",
    "generation rotated",
    "policy changed",
    "selection mismatch",
    "copied generation reader",
    "reminted generation reader",
  ] as const)("retains the admitted authority for %s", async (scenario) => {
    const generation = new SharedGatewaySessionGenerationState({
      current: "generation-a",
      required: null,
    });
    const connection = new AbortController();
    const client = createOperatorWsClient();
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "generation-a";
    setRuntimeConfigSnapshot({});
    client.authPolicy = captureGatewayAuthPolicy({}, null);
    client.connectionSignal = connection.signal;
    client.authenticatedUserProfile = {
      profileId: "profile-owner",
      displayName: null,
      avatarRevision: "1",
      hasAvatar: false,
      updatedAt: 1,
    };
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const persisted = vi.fn();
    const grantProfileReads = vi.fn();
    const compatibilityReader =
      scenario === "copied generation reader" || scenario === "reminted generation reader";
    const generationReader = generation.reader;
    const unboundReader = () => generation.current;
    if (scenario === "reminted generation reader") {
      for (const key of Object.getOwnPropertySymbols(generationReader)) {
        const value = Object.getOwnPropertyDescriptor(generationReader, key)?.value;
        const Issuer = value.constructor;
        if (typeof Issuer === "function") {
          Object.defineProperty(unboundReader, key, {
            value: new Issuer(unboundReader, generation),
          });
        }
      }
    }
    let inGrant = false;
    let grantError: unknown;
    vi.mocked(prepareUserProfileSelectionAuthority).mockImplementation(async (profile) => {
      if (inGrant) {
        grantProfileReads();
        throw new Error("host profile storage entered during worker admission");
      }
      return { profileId: profile, isCurrent: () => true };
    });
    const harness = createDispatchTestHarness({
      getRequiredSharedGatewaySessionGeneration:
        scenario === "copied generation reader"
          ? Object.defineProperties(
              () => generation.current,
              Object.getOwnPropertyDescriptors(generationReader),
            )
          : compatibilityReader
            ? unboundReader
            : generationReader,
      buildRequestContext: () => createDirectChatContext(),
      extraHandlers: {
        "test.mutation-custody": async (options) => {
          const authority = readGatewayRequestMutationAuthority(options);
          expect(authority.family).toBe(compatibilityReader ? "native-compatibility" : "worker");
          entered.resolve();
          await release.promise;
          try {
            if (compatibilityReader) {
              authority.assertCurrent();
            } else {
              if (authority.family !== "worker") {
                throw new Error("WS request lost its worker custody before handler invocation");
              }
              const forged = { ...options };
              const reminted = { ...options };
              const forgedReader = vi.fn(() => authority);
              for (const key of Object.getOwnPropertySymbols(options)) {
                const value = Object.getOwnPropertyDescriptor(options, key)?.value;
                const Issuer = value.constructor;
                if (typeof Issuer === "function") {
                  Object.defineProperty(reminted, key, {
                    value: new Issuer(reminted, authority),
                    configurable: true,
                  });
                }
                Object.defineProperty(forged, key, {
                  value: Object.assign(Object.create(Object.getPrototypeOf(value)), {
                    read: forgedReader,
                  }),
                  configurable: true,
                });
              }
              // Neither ordinary copies nor copied private descriptors transfer invocation custody.
              for (const copy of [
                { ...options },
                Object.assign(Object.create(options), options),
                Object.defineProperties({}, Object.getOwnPropertyDescriptors(options)),
                forged,
                reminted,
              ]) {
                expect(readGatewayRequestMutationAuthority(copy).family).toBe(
                  "native-compatibility",
                );
              }
              expect(forgedReader).not.toHaveBeenCalled();
              inGrant = true;
              authority.assertWorkerCurrent();
              expect(authority.expectedProfileBinding).toBeDefined();
              authority.expectedProfileBinding?.assertMatchesResolvedProfile(
                scenario === "selection mismatch" ? "different-profile" : "profile-owner",
              );
            }
            persisted();
          } catch (error) {
            grantError = error;
          } finally {
            inGrant = false;
          }
          options.respond(true, { settled: true });
        },
      },
    });
    const dispatch = harness.dispatcher.dispatch(
      {
        type: "req",
        id: "mutation-custody",
        method: "test.mutation-custody",
        expectedProfileId: "profile-owner",
        params: {},
      },
      client,
    );
    try {
      await Promise.race([
        entered.promise,
        dispatch.then(() => {
          throw new Error("request returned before reaching its mutation owner");
        }),
      ]);
      if (scenario === "transport retirement") {
        connection.abort();
      } else if (scenario === "client invalidated") {
        client.invalidated = true;
      } else if (scenario === "generation rotated" || compatibilityReader) {
        generation.publish({ current: "generation-b", required: generation.required });
      } else if (scenario === "policy changed") {
        setRuntimeConfigSnapshot({ gateway: { auth: { allowTailscale: true } } });
      }
    } finally {
      release.resolve();
      await dispatch;
    }
    expect(grantProfileReads).not.toHaveBeenCalled();
    if (scenario === "transport retirement") {
      expect(grantError).toBeUndefined();
      expect(persisted).toHaveBeenCalledOnce();
    } else {
      expect(grantError).toBeInstanceOf(Error);
      expect(persisted).not.toHaveBeenCalled();
    }
    if (scenario === "selection mismatch") {
      expect(grantError).toMatchObject({
        error: {
          details: { reason: "EXPECTED_PROFILE_MISMATCH", execution: "may_have_executed" },
        },
      });
    }
  });
});
