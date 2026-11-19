import { assert, expect, it } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import type {
  GatewayControlUiIngressFactoryV2,
  GatewayControlUiIngressOpenOptionsV2,
} from "../plugins/gateway-ingress.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./openclaw-id/tunnel-principal.js";
import { TEAM_ROLES, TRUSTED_PROXY } from "./remote-control-ui-ingress.integration.test-support.js";
import { createIngressPerson } from "./remote-control-ui-mcp-relay.test-support.js";
import { captureGatewayIngressPersonPrincipal } from "./remote-ingress-principal-admission.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

export function defineIdMemberPluginHttpTests(
  getFixture: () => {
    factory: GatewayControlUiIngressFactoryV2;
    pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>;
    workspaceDir: string;
    options: GatewayControlUiIngressOpenOptionsV2;
    foreignSessionKey: string;
    configureAuth: (
      auth: ResolvedGatewayAuth,
      roles: NonNullable<OpenClawConfig["gateway"]>["roles"],
    ) => Promise<void>;
  },
) {
  it.each(["initial", "cookie"] as const)(
    "retains the ID membership ceiling for %s plugin HTTP reads of a local admin profile",
    async (handoff) => {
      const { factory, pluginRegistry, workspaceDir, options, foreignSessionKey, configureAuth } =
        getFixture();
      const { publicOrigin, sandboxOrigin, frameAncestors, ...principalOptions } = options;
      const presentationOptions = { publicOrigin, sandboxOrigin, frameAncestors };
      await configureAuth(
        { mode: "trusted-proxy", trustedProxy: TRUSTED_PROXY, allowTailscale: false },
        TEAM_ROLES,
      );
      const profile = await createIngressPerson(`http-member-${handoff}`, "admin", workspaceDir);
      const claw = await linkedClaw();
      const peerKey = formatIrohEndpointKey(
        new Uint8Array(32).fill(handoff === "initial" ? 173 : 174),
      );
      const previousRegistry = getActivePluginRegistry();
      const pluginId = "ingress-sessions";
      const pluginPath = "/plugins/ingress-sessions/";
      pluginRegistry.httpRoutes.push({
        pluginId,
        path: pluginPath,
        auth: "gateway",
        match: "prefix",
        gatewayMethodDispatchAllowed: true,
        handler: async (_req, res) => {
          const result = await dispatchGatewayMethod("sessions.list", {
            configuredAgentsOnly: true,
            includeGlobal: false,
            includeUnknown: false,
          });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(result));
          return true;
        },
      });
      pluginRegistry.controlUiDescriptors.push({
        pluginId,
        source: "synthetic-ingress-plugin",
        descriptor: {
          id: "sessions",
          surface: "tab",
          label: "Ingress sessions",
          path: pluginPath,
          requiredScopes: ["operator.read"],
        },
      });
      setActivePluginRegistry(pluginRegistry);
      let binding: Awaited<ReturnType<typeof factory.bindPrincipal>> | undefined;
      let local: Awaited<ReturnType<typeof factory.bindPrincipal>> | undefined;
      try {
        expect(
          await claw.authority.submit(
            await claw.sign({
              op: "add",
              account_id: `ingress-http-${handoff}`,
              role: "reader",
              peer_keys: [peerKey],
              invite_id: null,
            }),
            "tunnel",
          ),
        ).toMatchObject({ ok: true });
        setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
        const source = await claw.authority.resolvePeer(peerKey);
        assert(source, "Missing signed ID member");
        binding = await factory.bindPrincipal({
          ...principalOptions,
          audienceId: `id-http-app-${handoff}`,
          operatorScopeCeiling: ["operator.read"],
          principal: captureGatewayIngressPersonPrincipal({
            connect: gatewayConnect(["operator.read"]),
            authenticatedUserProfile: gatewayProfile(profile.id),
            internal: { authenticatedOperator: true, openclawIdPrincipal: source },
          }),
        });
        const listParams = {
          configuredAgentsOnly: true,
          includeGlobal: false,
          includeUnknown: false,
        };
        const foreignSession = expect.objectContaining({ key: foreignSessionKey });
        const ownSession = expect.objectContaining({ key: `agent:main:ingress-${profile.id}` });
        const rpc = await binding.request("sessions.list", listParams);
        expect(rpc).toHaveProperty("sessions", expect.arrayContaining([ownSession]));
        expect(rpc).toHaveProperty("sessions", expect.not.arrayContaining([foreignSession]));
        const ui = await binding.openControlUi(presentationOptions);
        const headers: [string, string][] = [];
        if (handoff === "cookie") {
          const bootstrap = await ui.request({
            surface: "control-ui",
            method: "GET",
            pathAndQuery: "/claw/control-ui-config.json",
            headers: [],
            signal: principalOptions.signal,
          });
          expect(bootstrap.response.status).toBe(200);
          await bootstrap.response.body?.cancel();
          const readCookie = bootstrap.pluginReadCookies.find(
            (cookie) => cookie.kind === "iframe-read",
          );
          assert(readCookie, "Missing bootstrap-issued plugin read cookie");
          headers.push(["cookie", `${readCookie.name}=${readCookie.value}`]);
        }
        const { response } = await ui.request({
          surface: "control-ui",
          method: "GET",
          pathAndQuery: pluginPath,
          headers,
          signal: principalOptions.signal,
        });
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toMatchObject({ ok: true });
        expect(result).toHaveProperty("payload.sessions", expect.arrayContaining([ownSession]));
        expect(result).toHaveProperty(
          "payload.sessions",
          expect.not.arrayContaining([foreignSession]),
        );
        local = await factory.bindPrincipal({
          ...principalOptions,
          principal: { kind: "person", profileId: profile.id },
          audienceId: `local-http-app-${handoff}`,
          operatorScopeCeiling: ["operator.read"],
        });
        const { response: allowed } = await (
          await local.openControlUi(presentationOptions)
        ).request({
          surface: "control-ui",
          method: "GET",
          pathAndQuery: pluginPath,
          headers: [
            ["sec-fetch-mode", "cors"],
            ["sec-fetch-site", "same-origin"],
          ],
          signal: principalOptions.signal,
        });
        expect(allowed.status).toBe(200);
        expect(await allowed.json()).toHaveProperty(
          "payload.sessions",
          expect.arrayContaining([foreignSession]),
        );
      } finally {
        await binding?.close();
        await local?.close();
        setOpenClawIdTunnelPrincipalLookup(undefined);
        pluginRegistry.httpRoutes.length = 0;
        pluginRegistry.controlUiDescriptors.length = 0;
        setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
      }
    },
  );
}
