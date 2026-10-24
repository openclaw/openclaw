import assert from "node:assert/strict";
import { get } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import {
  onTrustedInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
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
      // Optional remote benchmark latency; normal regression runs use no timers.
      const latency = Number(process.env.OPENCLAW_IDENTITY_NETWORK_BENCH_MS ?? 0);
      const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        if (latency > 0) {
          await delay(latency);
        }
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
      const phases: number[] = [];
      const unsubscribe = onTrustedInternalDiagnosticEvent(
        (event) => {
          if (
            event.type === "diagnostic.phase.completed" &&
            event.name === "control-ui.document.auth_grants"
          ) {
            assert(typeof event.durationMs === "number", "Document phase duration is required");
            phases.push(event.durationMs);
          }
        },
        { includeTrusted: ["diagnostic.phase.completed"] },
      );
      const document = (route = "/") =>
        new Promise<string>((resolve, reject) => {
          get(
            {
              hostname: "127.0.0.1",
              port,
              path: route,
              headers,
            },
            (res) => {
              let body = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => {
                body += chunk;
              });
              res.on("end", () =>
                res.statusCode === 200
                  ? resolve(body)
                  : reject(new Error(`HTTP ${res.statusCode} ${route}: ${body.slice(0, 512)}`)),
              );
              res.on("error", reject);
            },
          ).on("error", reject);
        });
      try {
        expect(await document()).toContain("openclaw-test-control-ui");
        const coldCalls = transport.mock.calls.length;
        expect(await document()).toContain("openclaw-test-control-ui");
        const documentCalls = transport.mock.calls.length - coldCalls;
        const entryStarted = performance.now();
        expect(
          await document(`/__openclaw__/session-entry?path=${encodeURIComponent(deepLink)}`),
        ).toContain("openclaw-test-control-ui");
        const entryMs = performance.now() - entryStarted;
        const entryCalls = transport.mock.calls.length - coldCalls - documentCalls;
        const socket = await openWs(port, headers);
        const send = socket.send.bind(socket);
        let started = 0;
        // Measure the connect frame, excluding the fixture's device pre-pairing.
        const sendSpy = vi.spyOn(socket, "send").mockImplementation((...args) => {
          started = performance.now();
          send(...args);
        });
        try {
          const hello = await connectReq(socket, {
            skipDefaultAuth: true,
            prePairDevice: true,
            client: CONTROL_UI_CLIENT,
            scopes: ["operator.read"],
            browserOrigin: origin,
          });
          const helloMs = performance.now() - started;
          expect(started).toBeGreaterThan(0);
          expect(hello.ok, JSON.stringify(hello.error)).toBe(true);
          await waitForDiagnosticEventsDrained();
          expect(phases).toHaveLength(3);
          const wsCalls = transport.mock.calls.length - coldCalls - documentCalls - entryCalls;
          console.info(
            "IDENTITY_NETWORK_SAMPLE",
            JSON.stringify({
              phases,
              entryMs,
              helloMs,
              coldCalls,
              documentCalls,
              entryCalls,
              wsCalls,
            }),
          );
          expect(coldCalls).toBe(2);
          expect(documentCalls).toBe(0);
          expect(entryCalls).toBe(0);
          expect(wsCalls).toBe(0);
        } finally {
          sendSpy.mockRestore();
          socket.close();
        }
      } finally {
        unsubscribe();
        transport.mockRestore();
        vi.unstubAllEnvs();
      }
    },
    { port: 19673, serverOptions: { controlUiEnabled: true } },
  );
});
