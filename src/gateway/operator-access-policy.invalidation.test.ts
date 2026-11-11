import { expect, it } from "vitest";
import { bindPluginGatewayAccessPolicy } from "../plugins/gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { emitUserProfilesChanged } from "../state/user-profile-events.js";
import { resolvePreparedGatewayOperatorAccessAuthority } from "./operator-access-policy.js";

it.each([
  ["profile-invalidated", false],
  ["grant-revoked", false],
  ["plugin-lifetime-retired", false],
  ["plugin-lifetime-retired", true],
] as const)(
  "retains the first %s cause for every affected person (quiesced=%s) without disclosing source errors",
  async (cause, quiesced) => {
    const instance = createOwnedTestInstance("person-access");
    const grant = new AbortController();
    let profileCurrent = true;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: "person-access" }));
    registry.gatewayAccessPolicies.push({
      pluginId: "person-access",
      source: "fixture",
      policy: bindPluginGatewayAccessPolicy(
        {
          authorize: () => ({
            signal: grant.signal,
            assertCurrent: () => grant.signal.throwIfAborted(),
          }),
        },
        instance,
      ),
    });
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(registry, null, "default");
    try {
      const authorities = ["first-person", "second-person"].map((profileId) =>
        resolvePreparedGatewayOperatorAccessAuthority(
          { profileId, emails: [], role: null, isCurrent: () => profileCurrent },
          {},
        ),
      );
      for (const authority of authorities) {
        expect(authority?.signal.aborted).toBe(false);
      }
      if (cause === "profile-invalidated") {
        profileCurrent = false;
        emitUserProfilesChanged();
      } else if (cause === "grant-revoked") {
        grant.abort(new Error("PRIVATE synthetic source detail"));
      } else if (quiesced) {
        instance.quiesce();
        for (const authority of authorities) {
          expect(authority?.assertCurrent).toThrow(`[access-cause=${cause}]`);
        }
      } else {
        await instance.dispose();
      }
      for (const authority of authorities) {
        expect(authority?.signal.aborted).toBe(true);
        expect(authority).toMatchObject({ failureCause: cause });
        expect(authority?.assertCurrent).toThrow(`[access-cause=${cause}]`);
        expect(authority?.assertCurrent).not.toThrow("PRIVATE");
      }
      profileCurrent = true;
      grant.abort();
      for (const authority of authorities) {
        expect(authority).toMatchObject({ failureCause: cause });
      }
    } finally {
      grant.abort();
      await instance.dispose();
      rollbackStagedPluginRegistry(previous);
    }
  },
);
