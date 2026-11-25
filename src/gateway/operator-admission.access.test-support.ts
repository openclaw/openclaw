import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { assert, expect } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";
import { PROXY_USER, WRITER } from "./operator-admission.contracts.test-support.js";
import type { AdmissionCase, AdmissionFixture } from "./operator-admission.table.test-support.js";

type PluginGrantOwner = {
  pluginId: string;
  savedGrantId: string;
  currentGrantId: string;
  ended: boolean;
  denied: boolean;
  revocation: AbortController;
  remove: () => void;
  restore: () => void;
};

const owners = new WeakMap<AdmissionCase, PluginGrantOwner>();

function pluginGrantOwner(c: AdmissionCase) {
  const owner = owners.get(c);
  assert(owner, "Plugin grant row must register its real access-policy owner");
  return owner;
}

export function preparePluginAccessGrant(fixture: AdmissionFixture, c: AdmissionCase): void {
  assert(c.row.credential === "plugin-grant");
  const registry = getActivePluginRegistry();
  assert(registry, "Plugin grant must join the running Gateway registry");
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: `admission-access-${c.id}` });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: fixture.config, registrationMode: "full" });
  assert(getPluginInstance(record), "Access policy must have its production PluginInstance owner");
  const savedGrantId = randomUUID();
  const owner: PluginGrantOwner = {
    pluginId: record.id,
    savedGrantId,
    currentGrantId: savedGrantId,
    ended: false,
    denied: false,
    revocation: new AbortController(),
    remove() {
      const index = registry.gatewayAccessPolicies.indexOf(registration);
      if (index !== -1) {
        registry.gatewayAccessPolicies.splice(index, 1);
      }
    },
    restore() {
      if (!registry.gatewayAccessPolicies.includes(registration)) {
        registry.gatewayAccessPolicies.push(registration);
      }
    },
  };
  const currentGrant = () => ({
    grantId: owner.currentGrantId,
    signal: owner.revocation.signal,
    assertCurrent: () => owner.revocation.signal.throwIfAborted(),
  });
  const policy: PluginGatewayAccessPolicy = {
    authorize(input) {
      expect(input.requiredByRole).toBe(false);
      if (!input.profile.emails.includes(PROXY_USER)) {
        return undefined;
      }
      if (owner.denied) {
        throw new GatewayOperatorAccessDeniedError("grant-revoked");
      }
      return currentGrant();
    },
  };
  if (!["plugin-authorize-denied", "plugin-authorize-allowed"].includes(c.scenario)) {
    policy.resume = (input) => {
      expect(input.requiredByRole).toBe(false);
      expect(input.grantId).toBe(savedGrantId);
      assert(input.profile.emails.includes(PROXY_USER));
      return owner.ended ? undefined : currentGrant();
    };
  }
  api.registerGatewayAccessPolicy(policy);
  const registration = expectDefined(
    builder.registry.gatewayAccessPolicies[0],
    "Registered plugin access policy",
  );
  registry.plugins.push(record);
  owner.restore();
  owners.set(c, owner);
  const cleanup = () => {
    owner.revocation.abort(new GatewayOperatorAccessDeniedError("grant-revoked"));
    owner.remove();
    const index = registry.plugins.indexOf(record);
    if (index !== -1) {
      registry.plugins.splice(index, 1);
    }
    owners.delete(c);
  };
  c.service.signal.addEventListener("abort", cleanup, { once: true });
  fixture.restores.push(cleanup);
}

export function revokePluginAccessGrant(c: AdmissionCase): void {
  const owner = pluginGrantOwner(c);
  switch (c.scenario) {
    case "plugin-owner-unavailable":
      owner.remove();
      return;
    case "plugin-authorize-denied":
      owner.denied = true;
      return;
    case "plugin-authorize-allowed":
    case "plugin-resume-mismatch":
      owner.currentGrantId = randomUUID();
      expect(owner.currentGrantId).not.toBe(owner.savedGrantId);
      return;
    default:
      // Revoke the held authority after start, not merely its ability to resume.
      owner.ended = true;
      if (c.scenario === "after-start") {
        owner.revocation.abort(new GatewayOperatorAccessDeniedError("grant-revoked"));
      }
  }
}

export function restorePluginAccessGrantOwner(c: AdmissionCase): void {
  pluginGrantOwner(c).restore();
}

export function expectPluginAccessGrant(
  c: AdmissionCase,
  authority: AdmittedRunOperatorAuthority,
  recovered = false,
): void {
  const owner = pluginGrantOwner(c);
  expect(authority.gatewayAccessGrant).toEqual({
    pluginId: owner.pluginId,
    grantId: recovered ? owner.currentGrantId : owner.savedGrantId,
  });
  if (recovered) {
    expect([...authority.scopes].toSorted()).toEqual([...WRITER].toSorted());
  } else {
    const snapshot = authority.recoverySnapshot;
    assert(snapshot && snapshot.sourceIngress !== "principal");
    expect(snapshot.grant).toEqual({
      pluginId: owner.pluginId,
      grantId: owner.savedGrantId,
    });
    expect(snapshot.authPolicy.verifiedIdentity).toBe(PROXY_USER);
    expect([...snapshot.scopes].toSorted()).toEqual([...WRITER].toSorted());
  }
}
