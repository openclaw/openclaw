import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginGatewayAccessPolicy } from "../plugins/gateway-access-policy.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { checkAuthenticatedHttpUserProfile } from "./http-auth-user-profile.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import {
  hasGatewayOperatorAccessPolicies,
  resolveGatewayOperatorAccessAuthority,
  resolvePreparedGatewayOperatorAccessAuthority,
  resumeGatewayOperatorAccessGrant,
} from "./operator-access-policy.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { captureGatewayIngressPersonPrincipal } from "./remote-ingress-principal-admission.js";
import { dispatchProfile, gatewayConnect } from "./server/client-fixtures.test-support.js";
import type { GatewayConnectionTransport } from "./server/connection-transport.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const pluginId = "member-access";
const grantId = "780a6c68-5d66-4df6-b4e8-dba6d24264a2";
const member: OpenClawIdTunnelPrincipal = {
  kind: "member",
  peerKey: `iroh:${"ab".repeat(32)}`,
  accountId: "member-account",
  role: "member",
  authority: { clawId: "test-claw", rootPub: "test-root", listedSeq: 1 },
};
const source = { openclawIdPrincipal: member };
const profile = {
  profileId: "member-profile",
  emails: ["member@example.test"],
  assignedRole: "staff",
  githubLogin: "member-login",
};
const preparedProfile = { ...profile, role: profile.assignedRole, isCurrent: () => true };
const previousRegistry = captureActivePluginRegistrySnapshot();
const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.abort();
  }
  rollbackStagedPluginRegistry(previousRegistry);
  setOpenClawIdTunnelPrincipalLookup(undefined);
  clearRuntimeConfigSnapshot();
});

function fixture(defaultRole = false) {
  const config: OpenClawConfig = {
    gateway: {
      roles: {
        ...(defaultRole ? { default: "staff" } : {}),
        assignments: { byGithubLogin: { "member-login": "staff" } },
        definitions: {
          member: {
            scopes: ["operator.sessions.read"],
            agents: "*",
            sessions: { others: "view" },
            accessPolicyPlugin: pluginId,
          },
          staff: {
            scopes: ["operator.admin"],
            agents: "*",
            sessions: { others: "write" },
            accessPolicyPlugin: "staff-access",
          },
          unbound: { scopes: [], agents: [], sessions: { others: "none" } },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(config);
  setOpenClawIdTunnelPrincipalLookup(() => member);
  const registry = createEmptyPluginRegistry();
  stageActivePluginRegistry(registry, null, "default");
  const controller = new AbortController();
  controllers.push(controller);
  const authority = {
    grantId,
    signal: controller.signal,
    assertCurrent: () => controller.signal.throwIfAborted(),
  };
  function register(required = true) {
    const authorize = vi.fn<PluginGatewayAccessPolicy["authorize"]>(() =>
      required ? authority : undefined,
    );
    const resume = vi.fn<NonNullable<PluginGatewayAccessPolicy["resume"]>>(() => authority);
    registry.plugins.push(createPluginRecord({ id: pluginId }));
    registry.gatewayAccessPolicies.push({
      pluginId,
      source: "fixture",
      policy: { authorize, resume },
    });
    return { authorize, resume };
  }
  return { config, authority, register };
}

it("requires a member's missing plugin without enabling definitions-only policy for other sign-ins", () => {
  const { config } = fixture();
  expect(hasGatewayOperatorAccessPolicies(config)).toBe(false);
  expect(hasGatewayOperatorAccessPolicies(config, source)).toBe(true);
  expect(resolvePreparedGatewayOperatorAccessAuthority(preparedProfile, config)).toBeNull();
  expect(() =>
    resolvePreparedGatewayOperatorAccessAuthority(preparedProfile, config, source),
  ).toThrow("[access-cause=policy-unavailable]");
  expect(
    resolveGatewayOperatorAccessAuthority(GATEWAY_OWNER_PROFILE_ID, config, source),
  ).toBeNull();
});

it.each([false, true])(
  "uses membership rather than profile/GitHub/default binding (default=%s)",
  (defaultRole) => {
    const { config, register } = fixture(defaultRole);
    const { authorize, resume } = register();
    const access = resolvePreparedGatewayOperatorAccessAuthority(preparedProfile, config, source);
    expect(access?.requiredPolicyPlugin).toBe(pluginId);
    expect(access?.gatewayAccessGrant).toEqual({ pluginId, grantId });
    resumeGatewayOperatorAccessGrant(profile, config, { pluginId, grantId }, source);
    const expected = {
      config,
      profile: { profileId: profile.profileId, emails: profile.emails, assignedRole: "member" },
      requiredByRole: true,
    };
    expect(authorize).toHaveBeenCalledExactlyOnceWith(expected);
    expect(resume).toHaveBeenCalledExactlyOnceWith({ ...expected, grantId });
  },
);

it("does not inherit a profile binding when the membership role has no plugin", () => {
  const { config } = fixture(true);
  expect(() => resolvePreparedGatewayOperatorAccessAuthority(preparedProfile, config)).toThrow(
    "[access-cause=policy-unavailable]",
  );
  expect(
    resolvePreparedGatewayOperatorAccessAuthority(preparedProfile, config, {
      openclawIdPrincipal: { ...member, role: "unbound" },
    }),
  ).toBeNull();
});

it("requires confirmation from a loaded membership policy", () => {
  const { config, register } = fixture();
  register(false);
  expect(() =>
    resolvePreparedGatewayOperatorAccessAuthority(preparedProfile, config, source),
  ).toThrow("[access-cause=access-record-inactive]");
});

it("refuses recovered work without its membership grant and retains the exact live grant", () => {
  const { config, register, authority } = fixture();
  expect(() => resumeGatewayOperatorAccessGrant(profile, config, null, source)).toThrow(
    "[access-cause=policy-set-changed]",
  );
  expect(() =>
    resumeGatewayOperatorAccessGrant(
      profile,
      config,
      { pluginId: "staff-access", grantId },
      source,
    ),
  ).toThrow("[access-cause=policy-set-changed]");
  expect(() =>
    resumeGatewayOperatorAccessGrant(profile, config, { pluginId, grantId }, source),
  ).toThrow("Gateway access policy is unavailable");
  const { resume } = register();
  expect(
    resumeGatewayOperatorAccessGrant(
      profile,
      config,
      { pluginId, grantId },
      {
        ...source,
        retained: authority,
      },
    ),
  ).toBe(authority);
  expect(resume).not.toHaveBeenCalled();
});

it.each(["websocket", "http", "delegated"] as const)(
  "enforces the member plugin at %s admission",
  async (surface) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { config, register } = fixture();
      const person = await ensureCanonicalUserProfileForOpenClawIdIdentity({
        accountId: member.accountId,
      });
      const catalog = await prepareUserProfileCatalog();
      const socket: GatewayConnectionTransport = Object.assign(new EventEmitter(), {
        readyState: 1,
        bufferedAmount: 0,
        send() {},
        close() {},
        terminate() {},
      });
      const client: GatewayWsClient = {
        socket,
        connId: "member-access-test",
        connect: gatewayConnect(["operator.sessions.read"]),
        usesSharedGatewayAuth: false,
        authenticatedUserProfile: dispatchProfile(person.id),
        internal: { authenticatedOperator: true, openclawIdPrincipal: member },
      };
      const req = new IncomingMessage(new Socket());
      const http = () =>
        checkAuthenticatedHttpUserProfile({
          authResult: {
            ok: true,
            method: "trusted-proxy",
            user: "openclaw-id:member-account",
            openclawId: member,
          },
          cfg: config,
          getRuntimeConfig: () => config,
          req,
        });
      const lifetime = new AbortController();
      controllers.push(lifetime);
      const factory = createGatewayControlUiIngressFactory({
        pluginId: "test-ingress",
        signal: lifetime.signal,
        assertCurrent() {},
        host: {
          controlUiBasePath: "",
          signal: lifetime.signal,
          admissionSignal: lifetime.signal,
          getResolvedAuth: () => ({ mode: "token", token: "synthetic", allowTailscale: false }),
          getRuntimeConfig: () => config,
          handleRequest: async () => {},
          handleSandboxRequest: async () => {},
          handleUpgrade: async () => {},
        },
      });
      const bind = () =>
        factory.bindPrincipal({
          principal: captureGatewayIngressPersonPrincipal(client),
          audienceId: "member-app",
          operatorScopeCeiling: ["operator.sessions.read"],
          signal: lifetime.signal,
          assertCurrent() {},
        });
      try {
        if (surface === "websocket") {
          expect(() => prepareGatewayConnectOperatorAccess(client)).toThrow(
            "[access-cause=policy-unavailable]",
          );
          register();
          prepareGatewayConnectOperatorAccess(client);
          expect(client.internal?.operatorAccessAuthority?.requiredPolicyPlugin).toBe(pluginId);
        } else if (surface === "http") {
          expect(await http()).toMatchObject({
            ok: false,
            authResult: { reason: "operator_access_denied" },
          });
          register();
          expect(await http()).toMatchObject({
            ok: true,
            profile: { operatorAccessAuthority: { requiredPolicyPlugin: pluginId } },
          });
        } else {
          await expect(bind()).rejects.toMatchObject({ code: "forbidden" });
          register();
          const binding = await bind();
          await binding.close();
        }
      } finally {
        lifetime.abort();
        req.destroy();
        catalog.release();
      }
    });
  },
);
