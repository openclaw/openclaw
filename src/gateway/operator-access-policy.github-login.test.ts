import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  hasCurrentGatewayOperatorAccess,
  resolvePreparedGatewayOperatorAccessAuthority,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";

it("keeps GitHub login private while applying its mapped plugin binding on admission and recovery", () => {
  const pluginId = "person-access";
  const grantId = "780a6c68-5d66-4df6-b4e8-dba6d24264a2";
  const controller = new AbortController();
  const nativeAuthority = {
    grantId,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  const authorize = vi.fn<PluginGatewayAccessPolicy["authorize"]>(() => nativeAuthority);
  const resume = vi.fn<NonNullable<PluginGatewayAccessPolicy["resume"]>>(() => nativeAuthority);
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: pluginId }));
  registry.gatewayAccessPolicies.push({
    pluginId,
    source: "fixture",
    policy: { authorize, resume },
  });
  const previous = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(registry, null, "default");
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        default: "guest",
        assignments: { byGithubLogin: { "release-operator": "release" } },
        definitions: {
          guest: { sessions: { others: "none" }, agents: [], scopes: [] },
          release: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin"],
            accessPolicyPlugin: pluginId,
          },
        },
      },
    },
  };
  const profile = {
    profileId: "release-profile",
    emails: ["release@example.test"],
    githubAccountIds: [42],
    githubLogin: "Release-Operator",
    assignedRole: null,
  };
  let authority: ReturnType<typeof resolvePreparedGatewayOperatorAccessAuthority> = null;
  try {
    authority = resolvePreparedGatewayOperatorAccessAuthority(
      { ...profile, role: null, isCurrent: () => true },
      config,
    );
    expect(authority?.signal).toBeInstanceOf(AbortSignal);
    expect(hasCurrentGatewayOperatorAccess(authority)).toBe(true);
    expect(authority?.gatewayAccessGrant).toEqual({ pluginId, grantId });
    resumeGatewayOperatorAccessGrant(profile, config, { pluginId, grantId });
    const expected = {
      config,
      profile: {
        profileId: "release-profile",
        emails: ["release@example.test"],
        githubAccountIds: [42],
        assignedRole: null,
      },
      requiredByRole: true,
    };
    expect(authorize).toHaveBeenCalledExactlyOnceWith(expected);
    expect(resume).toHaveBeenCalledExactlyOnceWith({ ...expected, grantId });
  } finally {
    controller.abort();
    hasCurrentGatewayOperatorAccess(authority);
    rollbackStagedPluginRegistry(previous);
  }
});
