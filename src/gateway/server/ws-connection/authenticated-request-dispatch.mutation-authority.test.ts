import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { readUserProfileIdentity } from "../../../state/user-profile-list.js";
import { resolveGatewayAuthPolicyGeneration } from "../../auth-policy.js";
import { publishOperatorRoleConfigChange } from "../../operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../../operator-run-authority.js";
import { createDirectChatContext } from "../../server-chat.agent-events.test-helpers.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "../../server-methods/types.js";
import {
  captureSharedGatewaySessionGenerationOwnership,
  claimSharedGatewaySessionGenerationIfOwned,
  createRequiredSharedGatewaySessionGenerationReader,
  disconnectStaleSharedGatewayAuthClients,
  finalizeOwnedSharedGatewaySessionGeneration,
  replaceOwnedSharedGatewaySessionGenerationState,
  type SharedGatewaySessionGenerationState,
} from "../../server-shared-auth-generation.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

vi.mock("../../../state/user-profile-list.js", () => ({ readUserProfileIdentity: vi.fn() }));
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
  it.each(["commit", "rollback", "revoke all", "policy commit", "policy rollback"] as const)(
    "retains the accepted source through tentative transport fencing until %s",
    async (outcome) => {
      const generation: SharedGatewaySessionGenerationState = {
        current: "generation-a",
        required: null,
      };
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
      client.authPolicyGeneration = resolveGatewayAuthPolicyGeneration(committedConfig);
      client.connectionSignal = connection.signal;
      client.internal = { operatorRoleActor: { kind: "operator", profileId: "profile-owner" } };
      const context = createDirectChatContext({
        getRuntimeConfig: () => getRuntimeConfigSnapshot() ?? committedConfig,
        getCommittedRuntimeConfig: () => committedConfig,
      });
      context.resolveGatewayContext = () => context;
      let captured: ReturnType<typeof captureGatewayOperatorRunAuthority>;
      const handler = vi.fn<(options: GatewayRequestHandlerOptions) => void>((options) => {
        captured = captureGatewayOperatorRunAuthority({
          client: options.client,
          context,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          sourceAuthority: {
            assertCurrent: () => access.signal.throwIfAborted(),
            signal: access.signal,
          },
        });
        options.respond(true, { accepted: true });
      });
      const harness = createDispatchTestHarness({
        getRequiredSharedGatewaySessionGeneration:
          createRequiredSharedGatewaySessionGenerationReader(generation),
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
        let ownership = captureSharedGatewaySessionGenerationOwnership(generation);
        if (changesPolicy) {
          setRuntimeConfigSnapshot(nextConfig);
        } else {
          ownership = expectDefined(
            claimSharedGatewaySessionGenerationIfOwned(generation, ownership, "generation-b"),
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
          expect(finalizeOwnedSharedGatewaySessionGeneration(generation, ownership)).toBe(true);
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
              replaceOwnedSharedGatewaySessionGenerationState(generation, ownership, {
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
    "unchanged",
    "transport retirement",
    "client invalidated",
    "generation rotated",
    "policy changed",
    "selection mismatch",
    "opaque generation reader",
  ] as const)("retains the admitted authority for %s", async (scenario) => {
    const generation: SharedGatewaySessionGenerationState = {
      current: "generation-a",
      required: null,
    };
    const connection = new AbortController();
    const client = createOperatorWsClient();
    client.usesSharedGatewayAuth = true;
    client.sharedGatewaySessionGeneration = "generation-a";
    setRuntimeConfigSnapshot({});
    client.authPolicyGeneration = resolveGatewayAuthPolicyGeneration({});
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
    let inGrant = false;
    let grantError: unknown;
    vi.mocked(readUserProfileIdentity).mockImplementation((profile) => {
      if (inGrant) {
        grantProfileReads();
        throw new Error("host profile storage entered during worker admission");
      }
      return { profileId: profile, role: null, aliases: new Set([profile]) };
    });
    const harness = createDispatchTestHarness({
      getRequiredSharedGatewaySessionGeneration:
        scenario === "opaque generation reader"
          ? () => generation.current
          : createRequiredSharedGatewaySessionGenerationReader(generation),
      buildRequestContext: () => createDirectChatContext(),
      extraHandlers: {
        "test.mutation-custody": async (options) => {
          const authority = readGatewayRequestMutationAuthority(options);
          expect(authority.family).toBe(
            scenario === "opaque generation reader" ? "native-compatibility" : "worker",
          );
          entered.resolve();
          await release.promise;
          try {
            if (scenario === "opaque generation reader") {
              authority.assertCurrent();
            } else {
              if (authority.family !== "worker") {
                throw new Error("WS request lost its worker custody before handler invocation");
              }
              // A copied options object cannot acquire the invocation's private grant.
              expect(readGatewayRequestMutationAuthority({ ...options }).family).toBe(
                "native-compatibility",
              );
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
      } else if (scenario === "generation rotated" || scenario === "opaque generation reader") {
        generation.current = "generation-b";
      } else if (scenario === "policy changed") {
        setRuntimeConfigSnapshot({ gateway: { auth: { allowTailscale: true } } });
      }
    } finally {
      release.resolve();
      await dispatch;
    }
    expect(grantProfileReads).not.toHaveBeenCalled();
    if (scenario === "unchanged" || scenario === "transport retirement") {
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
