import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { operatorScopeSatisfied } from "../shared/operator-scope-compat.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { normalizeGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import {
  expectCurrent,
  pairedOperator,
  persistDevices,
  recoveryFixture,
  restoreFixture,
} from "./operator-run-recovery.test-support.js";

describe("recovered access policy", () => {
  it.each(["revoked", "unavailable", "replaced"] as const)(
    "finishes admitted work and evaluates current access when the grant is %s",
    (change) =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const pluginId = "recovery-access";
        let permitted = true;
        let unavailable = false;
        let grantId = "original-accepted-grant";
        const registry = createEmptyPluginRegistry();
        registry.plugins.push(createPluginRecord({ id: pluginId }));
        registry.gatewayAccessPolicies.push({
          pluginId,
          source: "fixture",
          policy: {
            authorize: () => {
              if (unavailable) {
                throw new GatewayOperatorAccessUnavailableError();
              }
              return permitted
                ? { grantId, signal: new AbortController().signal, assertCurrent() {} }
                : undefined;
            },
          },
        });
        const previous = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(registry, null, "default");
        try {
          const profile = ensureProfileForEmail("access@example.test");
          const fixture = await recoveryFixture(state.stateDir, profile.id, {
            scopes: ["operator.write"],
            gatewayAccessGrant: { pluginId, grantId },
            config: {
              gateway: {
                roles: {
                  default: "worker",
                  definitions: {
                    worker: {
                      scopes: ["operator.write"],
                      agents: "*",
                      sessions: { others: "none" },
                      accessPolicyPlugin: pluginId,
                    },
                  },
                },
              },
            },
          });
          using restored = await restoreFixture(fixture);
          if (change === "revoked") {
            permitted = false;
          } else if (change === "unavailable") {
            unavailable = true;
          } else {
            grantId = "replacement-current-grant";
          }
          expectCurrent(restored.authority);
          if (change === "replaced") {
            using next = await restoreFixture(fixture);
            expect(next.authority.gatewayAccessGrant).toEqual({ pluginId, grantId });
          } else {
            await expect(fixture.restore()).rejects.toThrow(
              change === "unavailable" ? GatewayOperatorAccessUnavailableError : Error,
            );
            unavailable = false;
            permitted = true;
            using next = await restoreFixture(fixture);
            expectCurrent(next.authority);
          }
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
        }
      }),
  );
});

it.each([false, true])(
  "uses current identity scopes at a Tailscale start (paired=%s)",
  async (paired) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const email = "identity-scopes@example.test";
      const profile = ensureProfileForEmail(email);
      const auth = {
        mode: "token" as const,
        token: "fixture-gateway-token",
        allowTailscale: true,
        identityScopes: { [email]: ["operator.write" as const] },
      };
      const config: OpenClawConfig = { gateway: { auth } };
      const fixture = await recoveryFixture(state.stateDir, profile.id, {
        config,
        scopes: ["operator.write"],
        device: paired ? pairedOperator() : undefined,
      });
      const snapshot = expectDefined(
        normalizeGatewayOperatorRecoverySnapshot({
          ...fixture.snapshot,
          authPolicy: {
            ...captureGatewayAuthPolicy(config, {
              role: "operator",
              authMethod: "tailscale",
              verifiedIdentity: email,
            }),
            generation: "",
          },
        }),
        "saved identity-authenticated requester",
      );
      if (paired) {
        const device = pairedOperator();
        expectDefined(device.tokens?.operator, "paired operator token").scopes = ["operator.read"];
        persistDevices(state.stateDir, [device], "both");
      }
      const admitted = await restoreGatewayOperatorSource({
        snapshot,
        context: fixture.context,
        assertCurrent() {},
      });
      try {
        expect(operatorScopeSatisfied("operator.write", admitted.authority.scopes)).toBe(true);
        fixture.setConfig({
          gateway: { auth: { ...auth, identityScopes: { [email]: ["operator.read"] } } },
        });
        // Current identity scopes narrow the next start to read, which starts no chat-like work.
        await expect(
          restoreGatewayOperatorSource({ snapshot, context: fixture.context, assertCurrent() {} }),
        ).rejects.toThrow("no longer allows sending messages");
        expectCurrent(admitted.authority);
        expect(operatorScopeSatisfied("operator.write", admitted.authority.scopes)).toBe(true);
      } finally {
        admitted.release();
      }
    });
  },
);
