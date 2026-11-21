import { expect, it } from "vitest";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
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

it("checks each person's original grant once through deep lineage and again before the next effect", async () => {
  const instance = createOwnedTestInstance("lineage-access");
  const grants = new Map(["alice", "bob"].map((id) => [id, new AbortController()]));
  const calls: string[] = [];
  let bobCurrent = true;
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "lineage-access" }));
  registry.gatewayAccessPolicies.push({
    pluginId: "lineage-access",
    source: "fixture",
    policy: bindPluginGatewayAccessPolicy(
      {
        authorize: ({ profile }) => ({
          // Equal grant identifiers must never share another person's decision.
          grantId: "shared-fixture-id",
          signal: grants.get(profile.profileId)!.signal,
          assertCurrent: () => {
            calls.push(profile.profileId);
            grants.get(profile.profileId)!.signal.throwIfAborted();
            if (profile.profileId === "bob" && !bobCurrent) {
              throw new Error("legacy grant ended without notification");
            }
          },
        }),
        resume: () => undefined,
      },
      instance,
    ),
  });
  const previous = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(registry, null, "default");
  const config = {};
  const admissions: ReturnType<typeof prepareSystemAgentRunAdmission>[] = [];
  let parent: (() => void) | undefined;
  try {
    for (let depth = 0; depth < 16; depth++) {
      const profileId = depth === 7 ? "bob" : "alice";
      const access = resolvePreparedGatewayOperatorAccessAuthority(
        {
          profileId,
          emails: [],
          role: null,
          isCurrent: () => true,
        },
        config,
      )!;
      const operator = createAdmittedRunOperatorAuthority({
        profileId,
        scopes: ["operator.write"],
        signal: access.signal,
        assertCurrent: access.assertCurrent,
      });
      const admission = prepareSystemAgentRunAdmission(
        config,
        `lineage-${depth}`,
        "main",
        "test",
        parent,
        operator,
      );
      admissions.push(admission);
      parent = resolveAdmittedRunActiveAssertion(await admission.admit("embedded"))!;
    }
    const effects: string[] = [];
    const effect = () => {
      parent!();
      effects.push("written");
    };
    calls.length = 0;
    effect();
    expect(calls).toEqual(["alice", "bob"]);
    effect();
    expect(calls).toEqual(["alice", "bob", "alice", "bob"]);
    await Promise.resolve();
    bobCurrent = false;
    expect(effect).toThrow();
    expect(effects).toHaveLength(2);
    expect(grants.get("alice")!.signal.aborted).toBe(false);
    expect(grants.get("bob")!.signal.aborted).toBe(false);
  } finally {
    for (const admission of admissions.toReversed()) {
      admission.close();
    }
    await instance.dispose();
    rollbackStagedPluginRegistry(previous);
  }
});

it("recomputes an unclassified failure before revoking a grant that ended without a signal", async () => {
  const instance = createOwnedTestInstance("person-access");
  const grant = new AbortController();
  let active = true;
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "person-access" }));
  registry.gatewayAccessPolicies.push({
    pluginId: "person-access",
    source: "fixture",
    policy: bindPluginGatewayAccessPolicy(
      {
        authorize: () => ({
          grantId: "original",
          signal: grant.signal,
          assertCurrent() {
            if (!active) {
              throw new Error("legacy policy denial");
            }
          },
        }),
        resume: () => undefined,
      },
      instance,
    ),
  });
  const previous = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(registry, null, "default");
  try {
    const authority = resolvePreparedGatewayOperatorAccessAuthority(
      { profileId: "person", emails: [], role: null, isCurrent: () => true },
      {},
    )!;
    active = false;
    expect(authority.assertCurrent).toThrow("access-cause=grant-revoked");
    expect(authority.signal.aborted).toBe(true);
    expect(grant.signal.aborted).toBe(false);
  } finally {
    await instance.dispose();
    rollbackStagedPluginRegistry(previous);
  }
});

it.each([
  ["profile-invalidated", false],
  ["grant-revoked", false],
  ["plugin-lifetime-retired", false],
  ["policy-unavailable", true],
] as const)(
  "distinguishes %s from revocation for every affected person (quiesced=%s)",
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
          expect(authority?.assertCurrent).toThrow("policy is unavailable");
          expect(authority?.signal.aborted).toBe(false);
        }
        instance.resume();
        for (const authority of authorities) {
          expect(authority?.assertCurrent).not.toThrow();
        }
        return;
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
