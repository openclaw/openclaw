import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setUserProfileRole, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeWsControlUiGatewayConnect, resolveGatewayAuth } from "./auth.js";
import { createAuthenticatedGitHubIdentitySync } from "./github-user-identity.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { createRequest } from "./server-http.test-harness.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resolveGatewayConnectProfileAdmission } from "./server/ws-connection/connect-user-profile.js";
import { withTempConfig } from "./test-temp-config.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("keeps public sign-in, durable roles and privileged dispatch independent of colliding Enterprise IDs", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const owner = syncGitHubIdentity({
      identity: { accountId: 9001, login: "bob" },
      authenticationAlias: { kind: "github-login", login: "bob" },
    });
    setUserProfileRole(owner.id, "maintainer");
    const cfg: OpenClawConfig = {
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
        controlUi: { github: { host: "ghe.example.test", token: "synthetic-enterprise-token" } },
        auth: { mode: "token", token: "synthetic-gateway-token", allowTailscale: true },
        roles: {
          default: "guest",
          definitions: {
            guest: { sessions: { others: "none" }, agents: [], scopes: [] },
            maintainer: { sessions: { others: "view" }, agents: "*", scopes: ["operator.admin"] },
          },
        },
      },
    };
    vi.stubEnv("GH_TOKEN", "synthetic-public-token");
    vi.stubEnv("GITHUB_TOKEN", undefined);
    const lookups: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      lookups.push(url.href);
      const login = url.pathname.split("/").at(-1);
      return new Response(
        JSON.stringify({
          id: url.hostname === "ghe.example.test" || login === "bob" ? 9001 : 42,
          login,
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    let effects = 0;
    const handler: GatewayRequestHandler = ({ respond }) => {
      effects += 1;
      respond(true, { completed: true });
    };
    const methodRegistry = createGatewayMethodRegistry([
      {
        name: "test.issuer-effect",
        owner: { kind: "aux", area: "issuer-proof" },
        scope: "operator.admin",
        handler,
      },
    ]);
    try {
      await withTempConfig({
        cfg,
        run: async () => {
          const context = createGatewayRequestContext(makeContextParams());
          for (const [login, allowed] of [
            ["bob", true],
            ["ada", false],
          ] as const) {
            const req = createRequest({
              path: "/",
              remoteAddress: "127.0.0.1",
              headers: {
                host: "gateway.local",
                "x-forwarded-for": "100.64.0.10",
                "x-forwarded-proto": "https",
                "x-forwarded-host": "gateway.example.ts.net",
                "tailscale-user-login": `${login}@github`,
                "tailscale-user-name": login,
              },
            });
            markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
            const authResult = await authorizeWsControlUiGatewayConnect({
              auth: resolveGatewayAuth({ authConfig: cfg.gateway?.auth }),
              connectAuth: null,
              req,
              tailscaleWhois: async () => ({ login: `${login}@github`, name: login }),
            });
            expect(authResult).toMatchObject({ ok: true, method: "tailscale" });
            const logWsControl = createSubsystemLogger("test/issuer");
            const warnings = vi.spyOn(logWsControl, "warn");
            const admission = await resolveGatewayConnectProfileAdmission({
              context: {
                configSnapshot: cfg,
                connectParams: createOperatorWsClient().connect,
                handler: {
                  connId: login,
                  logWsControl,
                  close: vi.fn(),
                },
                markHandshakeFailure: vi.fn(),
                sendHandshakeErrorResponse: vi.fn(),
                releasePendingNodePairingCleanup: async () => {},
              },
              state: { authResult, authMethod: authResult.method, role: "operator" },
              ownerProfileExpected: false,
              authenticatedUserId: authResult.user,
              resolveAuthenticatedGitHubIdentity: createAuthenticatedGitHubIdentitySync({
                authResult,
              }),
            });
            expect(admission.ok, warnings.mock.calls.map(([message]) => message).join("\n")).toBe(
              true,
            );
            if (!admission.ok || !admission.prepared) {
              throw new Error("Identity admission failed");
            }
            const client = createOperatorWsClient();
            client.authenticatedUserProfile = admission.prepared.profile;
            const response = await dispatchGatewayRequestInProcessRaw(
              "test.issuer-effect",
              {},
              { context, client, methodRegistry },
            );
            expect(response.ok).toBe(allowed);
            expect(effects).toBe(1);
            if (allowed) {
              expect(client.authenticatedUserProfile.profileId).toBe(owner.id);
            } else {
              expect(client.authenticatedUserProfile.profileId).not.toBe(owner.id);
            }
            req.destroy();
          }
        },
      });
      expect(lookups).toEqual([
        "https://api.github.com/users/bob",
        "https://api.github.com/users/ada",
      ]);
    } finally {
      invalidateOperatorRolePolicy(owner.id);
    }
  });
});
