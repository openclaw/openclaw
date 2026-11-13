import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import {
  bindOperatorModelExecution,
  getAdmittedRunDelegatedAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindPluginGatewayAccessPolicy } from "../plugins/gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { errorShapeFromError } from "./error-shape.js";
import { GatewayOperatorAccessUnavailableError } from "./operator-access-policy.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";

it.each(["closed-scope", "policy-error"])(
  "refuses a %s operation without revoking a live principal or its admitted descendants",
  (failure) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {
        gateway: {
          roles: {
            default: "writer",
            definitions: {
              writer: {
                scopes: ["operator.read", "operator.write"],
                agents: "*",
                sessions: { others: "none" },
                accessPolicyPlugin: "lineage-policy",
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(cfg);
      const profile = await ensureCanonicalUserProfileForEmail("lineage@example.test");
      const context = createGatewayRequestContext(makeContextParams());
      context.getRuntimeConfig = context.getCommittedRuntimeConfig = () => cfg;
      const instance = createOwnedTestInstance("lineage-policy");
      const grant = new AbortController();
      let unavailable = false;
      const registry = createEmptyPluginRegistry();
      registry.plugins.push(createPluginRecord({ id: "lineage-policy" }));
      registry.gatewayAccessPolicies.push({
        pluginId: "lineage-policy",
        source: "fixture",
        policy: bindPluginGatewayAccessPolicy(
          {
            authorize: () => ({
              signal: grant.signal,
              grantId: "lineage-grant",
              assertCurrent: () => {
                grant.signal.throwIfAborted();
                if (unavailable) {
                  throw new Error("synthetic policy failure");
                }
              },
            }),
          },
          instance,
        ),
      });
      const previous = captureActivePluginRegistrySnapshot();
      stageActivePluginRegistry(registry, null, "default");
      const releases: Array<() => void> = [];
      try {
        const sessionKey = "agent:main:lineage";
        const sessionId = "lineage-session";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profile.id },
          },
        );
        const captured = await prepareSessionPrincipalRunAuthority({
          context,
          agentId: "main",
          sessionKey,
          sessionId,
          profileId: profile.id,
        });
        releases.push(captured.release);
        let parent: (() => void) | undefined;
        const runs = [];
        for (let depth = 0; depth < 4; depth++) {
          const admission = prepareSystemAgentRunAdmission(
            cfg,
            `run-${depth}`,
            "main",
            "lineage",
            parent,
            captured.authority,
          );
          releases.push(admission.close);
          parent = admission.assertSourceCurrent;
          runs.push(await admission.admit("embedded"));
        }
        const active = resolveAdmittedRunActiveAssertion(runs[3]!)!;
        expect(active).toBeTypeOf("function");
        const model = bindOperatorModelExecution(captured.authority, {
          provider: "fixture",
          model: "model",
        })!;
        releases.push(model.release);
        const scope = new PluginInvocationScope(registry, [instance], { retained: true });
        const inScope = scope.run(() => AsyncLocalStorage.snapshot());
        scope.release();
        unavailable = failure === "policy-error";
        const invoke = failure === "closed-scope" ? () => inScope(active) : active;
        let error: unknown;
        try {
          invoke();
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(GatewayOperatorAccessUnavailableError);
        expect(errorShapeFromError("UNAVAILABLE", error)).toMatchObject({
          code: "UNAVAILABLE",
          retryable: true,
          details: { code: "OPERATOR_ACCESS_UNAVAILABLE" },
        });
        expect(captured.authority.signal?.aborted).toBe(false);
        expect(grant.signal.aborted).toBe(false);
        expect(
          failure === "closed-scope" ? () => inScope(model.assertCurrent) : model.assertCurrent,
        ).toThrow(GatewayOperatorAccessUnavailableError);
        expect(model.signal.aborted).toBe(false);
        unavailable = false;
        expect(active).not.toThrow();
        expect(model.assertCurrent).not.toThrow();
        for (const run of runs) {
          expect(getAdmittedRunDelegatedAuthority(run)).toBeDefined();
        }
        // A real grant revocation still cancels the same authority and refuses every descendant.
        grant.abort(new Error("grant revoked"));
        expect(captured.authority.signal?.aborted).toBe(true);
        expect(model.signal.aborted).toBe(true);
        expect(active).toThrow();
        for (const run of runs) {
          expect(getAdmittedRunDelegatedAuthority(run)).toBeUndefined();
        }
      } finally {
        for (const release of releases.toReversed()) {
          release();
        }
        rollbackStagedPluginRegistry(previous);
      }
    }),
);
