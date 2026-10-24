import { expect, it, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
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
    expect(authority?.requiredPolicyPlugin).toBe(pluginId);
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

function revisionPolicyFixture(options: { revision?: boolean; validity?: boolean } = {}) {
  const pluginId = "revision-access";
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        default: "visitor",
        definitions: {
          visitor: {
            sessions: { others: "none" },
            agents: [],
            scopes: ["operator.read"],
            accessPolicyPlugin: pluginId,
          },
        },
      },
    },
  };
  const facts = new Map<string, { allowed: boolean; validUntil: number; error?: Error }>();
  const captures: AbortController[] = [];
  const assertLive = vi.fn((profileId: string) => {
    const current = facts.get(profileId);
    if (current?.error) {
      throw current.error;
    }
    if (!current?.allowed || Date.now() >= current.validUntil) {
      throw new Error("Synthetic access ended");
    }
  });
  let publishRevision: (revision: string | undefined) => void = () => {
    throw new Error("Revision subscription was not installed");
  };
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({ id: pluginId, source: "revision-policy-fixture" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config, registrationMode: "full" });
  api.registerGatewayAccessPolicy({
    ...(options.revision === false
      ? {}
      : ({
          subscribeRevision(publish) {
            publishRevision = publish;
            publish("initial");
            return () => {};
          },
        } satisfies Pick<PluginGatewayAccessPolicy, "subscribeRevision">)),
    authorize({ profile }) {
      const controller = new AbortController();
      captures.push(controller);
      return {
        signal: controller.signal,
        assertCurrent: () => assertLive(profile.profileId),
        get recheckValidUntil() {
          return options.validity === false ? undefined : facts.get(profile.profileId)?.validUntil;
        },
      };
    },
  });
  const instance = getPluginInstance(record);
  if (!instance) {
    throw new Error("Policy fixture requires managed registration");
  }
  const previous = captureActivePluginRegistrySnapshot();
  stageActivePluginRegistry(builder.registry, null, "default");
  onTestFinished(async () => {
    for (const controller of captures) {
      controller.abort();
    }
    try {
      await instance.dispose();
    } finally {
      rollbackStagedPluginRegistry(previous);
    }
  });
  const capture = (profileId = "first", validUntil = Infinity) => {
    const state: { allowed: boolean; validUntil: number; error?: Error } = {
      allowed: true,
      validUntil,
    };
    facts.set(profileId, state);
    const authority = resolvePreparedGatewayOperatorAccessAuthority(
      {
        profileId,
        emails: [`${profileId}@example.test`],
        role: "visitor",
        isCurrent: () => true,
      },
      config,
      { requireLivePolicySet: true },
    );
    if (!authority) {
      throw new Error("Policy fixture requires captured authority");
    }
    return { authority, state };
  };
  return { capture, assertLive, publishRevision, instance };
}

it("keeps cached allows inside their exact ambient request scope", () => {
  const fixture = revisionPolicyFixture();
  const { authority } = fixture.capture();
  const first = { isWebchatConnect: () => false };
  const second = { isWebchatConnect: () => false };
  fixture.assertLive.mockClear();
  for (const scope of [first, second, first]) {
    withPluginRuntimeGatewayRequestScope(scope, () => {
      authority.assertCurrentForRecheck();
      authority.assertCurrentForRecheck();
    });
  }
  expect(fixture.assertLive).toHaveBeenCalledTimes(3);
});

it("reuses only classified rechecks and calls live immediately before effects and unclassified checks", () => {
  const fixture = revisionPolicyFixture();
  const { authority, state } = fixture.capture();
  const admittedCalls = fixture.assertLive.mock.calls.length;
  for (let index = 0; index < 20; index++) {
    authority.assertCurrentForRecheck();
  }
  expect(fixture.assertLive).toHaveBeenCalledTimes(admittedCalls);
  authority.assertCurrentForEffect();
  authority.assertCurrent();
  expect(fixture.assertLive).toHaveBeenCalledTimes(admittedCalls + 2);
  authority.assertCurrentForRecheck();
  state.allowed = false;
  // Even a plugin that fails to publish revocation cannot bypass the live effect check.
  expect(authority.assertCurrentForEffect).toThrow("Gateway access is not active");
  expect(fixture.assertLive).toHaveBeenCalledTimes(admittedCalls + 3);
});

it("revokes a cached allow at the next published revision and never revives the capture", () => {
  const fixture = revisionPolicyFixture();
  const { authority, state } = fixture.capture();
  authority.assertCurrentForRecheck();
  const beforeRevocation = fixture.assertLive.mock.calls.length;
  state.allowed = false;
  fixture.publishRevision("revoked");
  expect(authority.assertCurrentForRecheck).toThrow("Gateway access is not active");
  expect(fixture.assertLive).toHaveBeenCalledTimes(beforeRevocation + 1);
  expect(authority.signal.aborted).toBe(true);
  state.allowed = true;
  fixture.publishRevision("replacement");
  expect(authority.assertCurrentForRecheck).toThrow("Gateway access is not active");
});

it("expires a cached allow at its exact wall-clock bound without a timer or revision publication", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  onTestFinished(() => now.mockRestore());
  const fixture = revisionPolicyFixture();
  const { authority } = fixture.capture("expiring", 2_000);
  const admittedCalls = fixture.assertLive.mock.calls.length;
  now.mockReturnValue(1_999);
  authority.assertCurrentForRecheck();
  expect(fixture.assertLive).toHaveBeenCalledTimes(admittedCalls);
  now.mockReturnValue(2_000);
  expect(authority.assertCurrentForRecheck).toThrow("Gateway access is not active");
  expect(fixture.assertLive).toHaveBeenCalledTimes(admittedCalls + 1);
});

it.each(["no revision", "unknown revision", "no validity"])(
  "keeps rechecks live with %s",
  (missing) => {
    const fixture = revisionPolicyFixture({
      revision: missing !== "no revision",
      validity: missing !== "no validity",
    });
    const { authority } = fixture.capture();
    if (missing === "unknown revision") {
      fixture.publishRevision(undefined);
    }
    const admittedCalls = fixture.assertLive.mock.calls.length;
    authority.assertCurrentForRecheck();
    authority.assertCurrentForRecheck();
    expect(fixture.assertLive).toHaveBeenCalledTimes(admittedCalls + 2);
  },
);

it("fails closed on a plugin error and invalidates other cached answers from that policy", () => {
  const fixture = revisionPolicyFixture();
  const first = fixture.capture("first");
  const second = fixture.capture("second");
  first.authority.assertCurrentForRecheck();
  second.authority.assertCurrentForRecheck();
  first.state.error = new Error("private plugin failure");
  expect(first.authority.assertCurrentForEffect).toThrow("Gateway access is not active");
  const afterError = fixture.assertLive.mock.calls.length;
  second.authority.assertCurrentForRecheck();
  expect(fixture.assertLive).toHaveBeenCalledTimes(afterError + 1);
  first.state.error = undefined;
  fixture.publishRevision("recovered");
  expect(first.authority.assertCurrentForRecheck).toThrow("Gateway access is not active");
});

it("never shares an allow between interleaved principals at the same revision", () => {
  const fixture = revisionPolicyFixture();
  const first = fixture.capture("first");
  const second = fixture.capture("second");
  first.authority.assertCurrentForRecheck();
  second.authority.assertCurrentForRecheck();
  second.state.allowed = false;
  fixture.publishRevision("second-revoked");
  fixture.assertLive.mockClear();
  first.authority.assertCurrentForRecheck();
  expect(second.authority.assertCurrentForRecheck).toThrow("Gateway access is not active");
  first.authority.assertCurrentForRecheck();
  expect(fixture.assertLive.mock.calls).toEqual([["first"], ["second"], ["first"]]);
});

it("invalidates a cached allow when its managed plugin generation retires", async () => {
  const fixture = revisionPolicyFixture();
  const { authority } = fixture.capture();
  authority.assertCurrentForRecheck();
  await fixture.instance.dispose();
  expect(authority.assertCurrentForRecheck).toThrow("Gateway access is not active");
  expect(authority.assertCurrentForEffect).toThrow("Gateway access is not active");
});
