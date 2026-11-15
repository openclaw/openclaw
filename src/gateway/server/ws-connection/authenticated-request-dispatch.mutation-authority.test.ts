import { expectDefined } from "@openclaw/normalization-core";
import * as stableJson from "@openclaw/normalization-core/stable-stringify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { prepareUserProfileSelectionAuthority } from "../../../state/user-channel-identity-operations.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "../../auth-policy.js";
import {
  acceptGatewayDeviceSourceAuthority,
  readAcceptedGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "../../device-revocation.js";
import { publishOperatorRoleConfigChange } from "../../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import { createRemoteControlUiIngressTestContext } from "../../remote-control-ui.test-support.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  SharedGatewaySessionGenerationState,
} from "../../server-shared-auth-generation.js";
import { dispatchProfile } from "../client-fixtures.test-support.js";
import { createRequestGate } from "./authenticated-request-dispatch.fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";

type Capture = NonNullable<Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>>;
type CaptureOptions = Parameters<typeof captureGatewayOperatorRunAuthority>[0];
function createGeneration(current?: string) {
  return new SharedGatewaySessionGenerationState({ current, required: null });
}
function createCaptureFixture(params: {
  config: () => OpenClawConfig;
  profileId: string;
  method: string;
  policy?: Parameters<typeof captureGatewayAuthPolicy>[1];
  generation?: SharedGatewaySessionGenerationState;
  connection?: AbortController;
  sourceAuthority?: CaptureOptions["sourceAuthority"];
  requireGuard?: boolean;
}) {
  const client = createOperatorWsClient(
    params.connection ? { socket: { close: () => params.connection?.abort() } } : {},
  );
  client.authPolicy = captureGatewayAuthPolicy(params.config(), params.policy ?? null);
  client.internal = { operatorRoleActor: { kind: "operator", profileId: params.profileId } };
  if (params.connection) {
    client.connectionSignal = params.connection.signal;
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "generation-a";
  }
  const context = createDirectChatContext({
    getRuntimeConfig: () =>
      params.connection ? (getRuntimeConfigSnapshot() ?? params.config()) : params.config(),
    getCommittedRuntimeConfig: params.config,
  });
  context.resolveGatewayContext = () => context;
  const captures: Capture[] = [];
  const handler = vi.fn(async (options: GatewayRequestHandlerOptions) => {
    const current = params.requireGuard
      ? expectDefined(options.hasCurrentClientAuthority, "WS caller guard")
      : options.hasCurrentClientAuthority;
    const captured = await captureGatewayOperatorRunAuthority({
      client: options.client,
      context,
      hasCurrentClientAuthority: current,
      sourceAuthority: params.sourceAuthority,
    });
    captures.push(expectDefined(captured, "captured operator source"));
    options.respond(true, { accepted: true });
  });
  const harness = createDispatchTestHarness({
    buildRequestContext: () => context,
    getRequiredSharedGatewaySessionGeneration: params.generation?.reader,
    extraHandlers: { [params.method]: handler },
  });
  const dispatch = (id: string) =>
    harness.dispatcher.dispatch(requestFrame(id, params.method), client);
  return { client, context, captures, handler, harness, dispatch };
}

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
  it("retains the equivalent committed grant across checks and rejects the next revocation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const email = "retained-policy@example.test";
      let committedConfig: OpenClawConfig = {
        gateway: { auth: { identityScopes: { [email]: ["operator.admin"] } } },
      };
      setRuntimeConfigSnapshot(committedConfig);
      const { captures, dispatch } = createCaptureFixture({
        config: () => committedConfig,
        profileId: ensureProfileForEmail(email).id,
        method: "test.retained-policy",
        policy: { role: "operator", authMethod: "token", verifiedIdentity: email },
        requireGuard: true,
      });
      await dispatch("accepted-policy");
      const retained = expectDefined(captures.at(-1), "accepted operator source");
      using _ = { [Symbol.dispose]: retained.release };
      const stringify = vi.spyOn(stableJson, "stableStringify");
      try {
        committedConfig = structuredClone(committedConfig);
        retained.authority.assertCurrent();
        stringify.mockClear();
        retained.authority.assertCurrent();
        expect(stringify).not.toHaveBeenCalled();

        const acceptedConfig = committedConfig;
        committedConfig = {
          gateway: { auth: { identityScopes: { [email]: ["operator.read"] } } },
        };
        expect(retained.authority.assertCurrent).toThrow();
        committedConfig = acceptedConfig;
        expect(retained.authority.assertCurrent).toThrow();
      } finally {
        stringify.mockRestore();
      }
    });
  });

  it("retains the remote grant assertion after accepted work leaves its request", async () => {
    setRuntimeConfigSnapshot({});
    const ingress = new AbortController();
    const client = createOperatorWsClient();
    client.remoteControlUiIngress = createRemoteControlUiIngressTestContext({
      assertCurrent: () => ingress.signal.throwIfAborted(),
    });
    const generation = createGeneration();
    let source: (() => boolean) | undefined;
    let release: (() => void) | undefined;
    const harness = createDispatchTestHarness({
      getRequiredSharedGatewaySessionGeneration: generation.reader,
      buildRequestContext: () => createDirectChatContext(),
      extraHandlers: {
        "test.accepted-remote": (options) => {
          release = retainGatewayDeviceRevocation(options.hasCurrentClientAuthority);
          expect(acceptGatewayDeviceSourceAuthority(options.hasCurrentClientAuthority)).toBe(true);
          source = readAcceptedGatewayDeviceSourceAuthority(options.hasCurrentClientAuthority);
          options.respond(true);
        },
      },
    });
    try {
      await harness.dispatcher.dispatch(
        requestFrame("accepted-remote", "test.accepted-remote"),
        client,
      );
      expect(source?.()).toBe(true);
      expect([...harness.clients.authorityClients]).toEqual([client]);
      ingress.abort(new Error("remote grant expired"));
      expect(source?.()).toBe(false);
    } finally {
      release?.();
      expect([...harness.clients.authorityClients]).toEqual([]);
    }
  });

  it("keeps original wildcard model ceilings separate through WS capture and contiguous collect", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const profile = ensureProfileForEmail("queued-model-ceiling@example.test");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const modelA = { provider: "fixture", model: "family-a" };
      const modelB = { provider: "fixture", model: "family-b" };
      const guest = {
        sessions: { others: "none" as const },
        agents: "*" as const,
        scopes: ["operator.admin" as const],
        modelPolicy: { allow: ["fixture/family-*"] },
      };
      let committedConfig: OpenClawConfig = {
        agents: { defaults: { model: "fixture/family-a" } },
        gateway: { roles: { default: "guest", definitions: { guest } } },
      };
      setRuntimeConfigSnapshot(committedConfig);
      const { captures, harness, dispatch, context } = createCaptureFixture({
        config: () => committedConfig,
        profileId: profile.id,
        method: "test.model-ceiling",
        requireGuard: true,
      });
      const capture = async (id: string) => {
        await dispatch(id);
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

  it.each(["commit", "rollback", "revoke all", "policy commit", "policy rollback"] as const)(
    "retains the accepted source through tentative transport fencing until %s",
    async (outcome) => {
      const generation = createGeneration("generation-a");
      let committedConfig: OpenClawConfig = { gateway: { auth: { allowTailscale: true } } };
      const nextConfig: OpenClawConfig = { gateway: { auth: { allowTailscale: false } } };
      const changesPolicy = outcome === "policy commit" || outcome === "policy rollback";
      setRuntimeConfigSnapshot(committedConfig);
      const connection = new AbortController();
      const access = new AbortController();
      const { client, context, captures, handler, harness, dispatch } = createCaptureFixture({
        config: () => committedConfig,
        profileId: ensureProfileForEmail("transport-owner@example.test").id,
        method: "test.source-custody",
        generation,
        connection,
        policy: { role: "operator", authMethod: "tailscale" },
        sourceAuthority: {
          assertCurrent: () => access.signal.throwIfAborted(),
          signal: access.signal,
        },
      });
      harness.close.mockImplementation(() => connection.abort());
      const disconnect = (
        expectedGeneration: string | null,
        clients = [client],
        revokeSource?: false,
      ) =>
        disconnectStaleSharedGatewayAuthClients({
          state: generation,
          clients,
          expectedGeneration,
          revokeSource,
        });
      await dispatch("accepted-source");
      const accepted = expectDefined(captures.at(-1), "accepted source");
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
          disconnect("generation-b", [client], false);
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
          disconnect(null, []);
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
            const restored = generation.replace(ownership, {
              current: "generation-a",
              required: null,
            });
            expect(restored).toBe(true);
            // The original connection has left the socket set; rollback preserves its old source.
            disconnect("generation-a", []);
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
  ] as const)("retains the admitted authority for %s", async (scenario) => {
    const generation = createGeneration("generation-a");
    const connection = new AbortController();
    const client = createOperatorWsClient();
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "generation-a";
    setRuntimeConfigSnapshot({});
    client.authPolicy = captureGatewayAuthPolicy({}, null);
    client.connectionSignal = connection.signal;
    client.authenticatedUserProfile = dispatchProfile("profile-owner");
    const gate = createRequestGate();
    const persisted = vi.fn();
    const grantProfileReads = vi.fn();
    const compatibilityReader = scenario === "copied generation reader";
    const generationReader = generation.reader;
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
          : generationReader,
      buildRequestContext: () => createDirectChatContext(),
      extraHandlers: {
        "test.mutation-custody": async (options) => {
          const authority = readGatewayRequestMutationAuthority(options);
          expect(authority.family).toBe(compatibilityReader ? "native-compatibility" : "worker");
          await gate.wait();
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
        ...requestFrame("mutation-custody", "test.mutation-custody"),
        expectedProfileId: "profile-owner",
      },
      client,
    );
    try {
      await Promise.race([
        gate.entered,
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
      gate.release();
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
