import path from "node:path";
import { expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  accessOrigin,
  githubCfg,
  identityResponse,
  oidcIdentity,
} from "./github-user-identity.oidc.test-support.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("reuses verified Access identity across a document reload and WebSocket hello", async () => {
  const origin = "https://control.example.test";
  const auth = {
    ...githubCfg.gateway!.auth!,
    trustedProxy: { ...githubCfg.gateway!.auth!.trustedProxy!, allowLoopback: true },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", sessions: { others: "view" }, scopes: ["operator.read"] },
        },
      },
    },
  });
  const deepLink = "/chat/main/dashboard/12345678-aaaa-4000-8000-000000000001";
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey: "agent:main:dashboard:12345678-aaaa-4000-8000-000000000001" },
    { sessionId: "identity-network", updatedAt: 1, displayName: "Synthetic identity dashboard" },
  );
  await withGatewayServer(
    async ({ port }) => {
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
      vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
      const fetchDocument = globalThis.fetch;
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (url === `${accessOrigin}/cdn-cgi/access/get-identity`) {
          return identityResponse(oidcIdentity());
        }
        expect(url).toBe("https://api.github.com/user/101");
        return identityResponse({ id: 101, login: "ada" });
      });
      const headers = {
        origin,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
        "cf-access-authenticated-user-email": "ada@example.test",
        "cf-access-jwt-assertion": `header.${Buffer.from(
          JSON.stringify({ iss: accessOrigin, exp: Math.floor(Date.now() / 1_000) + 600 }),
        ).toString("base64url")}.signature`,
      };
      const document = async (route = "/") => {
        const response = await fetchDocument(`http://127.0.0.1:${port}${route}`, {
          headers,
          redirect: "manual",
        });
        expect(response.status).toBe(200);
        return response.text();
      };
      try {
        expect(await document()).toContain("openclaw-test-control-ui");
        expect(transport).toHaveBeenCalledTimes(2);
        expect(await document()).toContain("openclaw-test-control-ui");
        expect(transport).toHaveBeenCalledTimes(2);
        expect(
          await document(`/__openclaw__/session-entry?path=${encodeURIComponent(deepLink)}`),
        ).toContain("openclaw-test-control-ui");
        expect(transport).toHaveBeenCalledTimes(2);
        const socket = await openWs(port, headers);
        try {
          const hello = await connectReq(socket, {
            skipDefaultAuth: true,
            prePairDevice: true,
            client: CONTROL_UI_CLIENT,
            scopes: ["operator.read"],
            browserOrigin: origin,
          });
          expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
          expect(transport).toHaveBeenCalledTimes(2);
        } finally {
          socket.close();
        }
      } finally {
        transport.mockRestore();
        vi.unstubAllEnvs();
      }
    },
    { port: 19673, serverOptions: { controlUiEnabled: true } },
  );
});
