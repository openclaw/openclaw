import { expect, test } from "vitest";
import {
  BROWSER_ORIGIN,
  CONTROL_UI_CLIENT,
  TRUSTED_BROWSER_HEADERS,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const IDENTITY = "workspace-files";
const MAIN = "agent:main:main";

// A proxy that caps one shared browser identity to conversation access per route.
test("a session-scoped browser starts the main conversation without broader access", async () => {
  await configureBrowserAuth(
    browserProxyAuth({
      identityScopes: { [IDENTITY]: ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-openclaw-scopes"],
        allowUsers: [IDENTITY],
        allowLoopback: true,
      },
    }),
  );
  await withGatewayServer(async ({ port }) => {
    const ws = await openWs(port, {
      ...TRUSTED_BROWSER_HEADERS,
      "x-forwarded-user": IDENTITY,
      "x-openclaw-scopes": "operator.sessions.write",
    });
    try {
      const connected = await connectReq(ws, {
        prePairDevice: true,
        client: CONTROL_UI_CLIENT,
        browserOrigin: BROWSER_ORIGIN,
        skipDefaultAuth: true,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
      expect(connected.payload).toMatchObject({ auth: { scopes: ["operator.sessions.write"] } });

      const subscribed = await rpcReq(ws, "sessions.messages.subscribe", {
        key: MAIN,
        initialHistory: {},
      });
      expect(subscribed.ok, JSON.stringify(subscribed.error)).toBe(true);
      expect(subscribed.payload).toMatchObject({
        subscribed: true,
        key: MAIN,
        initialHistory: { ok: true, payload: { messages: [] } },
      });
      // No session ID: a successful read that proves the conversation does not exist yet.
      const history = (
        subscribed.payload as { initialHistory: { payload: { sessionId?: unknown } } }
      ).initialHistory.payload;
      expect(history.sessionId ?? null).toBeNull();

      // Absence of any other conversation stays indistinguishable from a hidden one.
      const other = await rpcReq(ws, "sessions.messages.subscribe", { key: "agent:main:other" });
      expect(other).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining("not found") },
      });

      const sent = await rpcReq(ws, "chat.send", {
        sessionKey: MAIN,
        message: "hello",
        idempotencyKey: "narrow-main-first-turn",
      });
      expect(sent.ok, JSON.stringify(sent.error)).toBe(true);

      // The connection keeps its cap: no configuration or approval access.
      expect(await rpcReq(ws, "config.get", {})).toMatchObject({
        ok: false,
        error: { code: "FORBIDDEN", details: { missingScope: "operator.read" } },
      });
    } finally {
      ws.close();
    }
  });
});
