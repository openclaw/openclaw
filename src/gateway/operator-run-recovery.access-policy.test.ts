import { describe, expect, it } from "vitest";
import { GatewayOperatorAccessUnavailableError } from "../infra/operator-authority-error.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  expectCurrent,
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
