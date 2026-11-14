import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readOperatorAuthorityFailure } from "../infra/operator-authority-error.js";
import { bindPluginGatewayAccessPolicy } from "../plugins/gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureResidentUserProfileAccess } from "../state/user-profile-list.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolvePreparedGatewayOperatorAccessAuthority,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import { bindIndependentContinuationAuthority } from "./operator-run-authority.continuation.js";
import { captureOperatorToolGatewayContinuationContext } from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

it.each([
  "current",
  "grant-revoked",
  "plugin-lifetime-retired",
  "policy-set-changed",
  "required-policy-changed",
  "gateway-replaced",
] as const)(
  "checks raw retained authority after a live continuation body outlives its producer: %s",
  (boundary) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const { databasePath, assertDatabasePath } = installPrivateUpdateHandoffStore(stateDir);
      assertDatabasePath(databasePath);
      const instance = createOwnedTestInstance("person-access");
      const registry = instance.owner!.registry!;
      const grant = new AbortController();
      let authorizations = 0;
      registry.gatewayAccessPolicies.push({
        pluginId: instance.pluginId,
        source: "fixture",
        policy: bindPluginGatewayAccessPolicy(
          {
            authorize: () => {
              authorizations++;
              return {
                grantId: "original",
                signal: grant.signal,
                assertCurrent: () => grant.signal.throwIfAborted(),
              };
            },
          },
          instance,
        ),
      });
      const previous = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(registry, null, "default");
      const producer = new PluginInvocationScope(registry, [instance]);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      let captured: Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>;
      let pending: Promise<void> | undefined;
      let effects = 0;
      try {
        const client = createOperatorClient({
          profileName: "continuation-lease",
          scopes: ["operator.write"],
        });
        const config: OpenClawConfig = {
          gateway: {
            roles: {
              default: "member",
              definitions: {
                member: {
                  scopes: ["operator.write"],
                  agents: "*",
                  sessions: { others: "none" },
                  accessPolicyPlugin: "person-access",
                },
              },
            },
          },
        };
        const context = createContext([], () => config);
        let currentGateway: typeof context | undefined = context;
        context.resolveGatewayContext = () => currentGateway;
        const access = resolvePreparedGatewayOperatorAccessAuthority(
          {
            profileId: client.authenticatedUserProfile!.profileId,
            emails: [],
            role: null,
            isCurrent: () => true,
          },
          config,
          { requireLivePolicySet: true },
        );
        assert(access);
        expect(access.requiredPolicyPlugin).toBe("person-access");
        client.internal = { operatorAccessAuthority: access };
        await producer.run(async () => {
          captured = await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: context.resolveGatewayContext,
              isWebchatConnect: () => false,
            },
            () => captureOperatorToolGatewayContinuationContext(),
          );
          assert(captured?.operatorAuthority);
          // Enter while live: entry-only detachment cannot cover this suspended body.
          pending = captured.run(async () => {
            entered.resolve();
            await resume.promise;
            captured!.operatorAuthority!.assertCurrent();
            captured!.assertCurrent();
            if (boundary === "current") {
              const release = captured!.operatorAuthority!.retain!();
              try {
                expect(captured!.operatorAuthority!.readCurrentRoleFacts!()).toMatchObject({
                  assignedRole: null,
                });
              } finally {
                release();
              }
            }
            if (boundary === "required-policy-changed") {
              // The resume boundary, not raw retained grant assertion, owns this fence.
              resumeGatewayOperatorAccessGrant(
                captureResidentUserProfileAccess(
                  client.authenticatedUserProfile!.profileId,
                ).readCurrentFacts(),
                config,
                access.gatewayAccessGrant!,
              );
            }
            effects++;
          });
          void pending.catch(() => {});
          await entered.promise;
        });
        producer.release();
        if (boundary === "grant-revoked") {
          grant.abort(new Error("private grant revoked"));
        }
        if (boundary === "plugin-lifetime-retired") {
          await instance.dispose();
        }
        if (boundary === "policy-set-changed") {
          registry.gatewayAccessPolicies.splice(0);
        }
        if (boundary === "required-policy-changed") {
          config.gateway!.roles!.definitions.member!.accessPolicyPlugin = "replacement";
        }
        if (boundary === "gateway-replaced") {
          currentGateway = createContext();
        }
        resume.resolve();
        if (boundary === "current") {
          await expect(pending).resolves.toBeUndefined();
          expect(effects).toBe(1);
          expect(access.signal.aborted).toBe(false);
        } else {
          await expect(pending).rejects.toThrow();
          expect(effects).toBe(0);
          if (boundary === "gateway-replaced") {
            expect(await pending?.catch(readOperatorAuthorityFailure)).toMatchObject({
              operatorAuthorityReason: "gateway-identity-retired",
              operatorAuthorityCheck: "gateway-current",
            });
            expect(access.signal.aborted).toBe(false);
          } else if (boundary === "required-policy-changed") {
            await expect(pending).rejects.toMatchObject({ accessCause: "policy-set-changed" });
            expect(access.signal.aborted).toBe(false);
          } else {
            expect(access.failureCause).toBe(boundary);
          }
        }
        expect(authorizations).toBe(1);
      } finally {
        resume.resolve();
        await pending?.catch(() => {});
        captured?.release();
        producer.release();
        rollbackStagedPluginRegistry(previous);
      }
    }),
);

it.each(["assertion", "abort"] as const)(
  "keeps repeated independent bindings stable with %s revocation",
  (revocation) => {
    const controller = new AbortController();
    const failure = new Error("original continuation source retired");
    let current = true;
    let checks = 0;
    let holds = 0;
    const original = createAdmittedRunOperatorAuthority({
      profileId: "stable-continuation",
      scopes: ["operator.read"],
      signal: controller.signal,
      assertCurrent: () => {
        checks++;
        if (!current) {
          throw failure;
        }
      },
      retain: () => {
        holds++;
        return () => {
          holds--;
        };
      },
    });
    const first = bindIndependentContinuationAuthority(original);
    expect(first).not.toBe(original);
    expect(first.source).toBe(original.source);
    expect(first.signal).toBe(controller.signal);
    expect(first.scopes).toEqual(original.scopes);
    expect(holds).toBe(0);
    let continuation = first;
    for (let hop = 0; hop < 3; hop++) {
      continuation = bindIndependentContinuationAuthority(continuation);
      expect(continuation).toBe(first);
      continuation.assertCurrent();
    }
    expect(checks).toBe(3);
    const release = continuation.retain!();
    expect(holds).toBe(1);
    release();
    expect(holds).toBe(0);
    if (revocation === "abort") {
      controller.abort(failure);
    } else {
      current = false;
    }
    expect(() => continuation.assertCurrent()).toThrow(failure);
    current = true;
    expect(() => bindIndependentContinuationAuthority(continuation).assertCurrent()).toThrow(
      failure,
    );
    expect(checks).toBe(revocation === "abort" ? 3 : 4);
  },
);
