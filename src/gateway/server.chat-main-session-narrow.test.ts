import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, test } from "vitest";
import type { WebSocket } from "ws";
import type { GatewayOperatorRolesConfig } from "../config/types.gateway.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  BROWSER_ORIGIN,
  CONTROL_UI_CLIENT,
  TRUSTED_BROWSER_HEADERS,
  browserProxyAuth,
  configureBrowserAuth,
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  rpcReq,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const IDENTITY = "workspace-files";
const MEMBER = "member@example.test";
const OWNER = "owner@example.test";
const MAIN = "agent:main:main";
const READ_WRITE: OperatorScope[] = ["operator.read", "operator.write"];
const role = (others: "none" | "view", scopes = READ_WRITE) => ({
  sessions: { others },
  agents: "*" as const,
  scopes,
});
// The same scopes with a narrower session cap, and no scopes at all.
const ROLES = {
  default: "view",
  definitions: { view: role("view"), none: role("none"), denied: role("none", []) },
} satisfies GatewayOperatorRolesConfig;

// A proxy that caps each browser to conversation access per route.
async function connect(port: number, user: string, scope = "operator.sessions.write") {
  const ws = await openWs(port, {
    ...TRUSTED_BROWSER_HEADERS,
    "x-forwarded-user": user,
    "x-openclaw-scopes": scope,
  });
  const root = path.join(process.env.OPENCLAW_STATE_DIR!, user);
  const connected = await connectReq(ws, {
    prePairDevice: true,
    client: CONTROL_UI_CLIENT,
    browserOrigin: BROWSER_ORIGIN,
    skipDefaultAuth: true,
    scopes: ["operator.admin", "operator.read", "operator.write"],
    deviceIdentityPath: path.join(root, "client", "credentials.sqlite"),
  });
  expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
  expect(connected.payload).toMatchObject({ auth: { scopes: scope.split(",") } });
  // Every frame this socket receives about main, in wire order.
  const frames: Array<{ event?: string }> = [];
  ws.on("message", (data) => {
    const text = rawDataToString(data);
    if (text.includes(MAIN)) {
      frames.push(JSON.parse(text));
    }
  });
  return { ws, frames };
}

async function configure(roles?: GatewayOperatorRolesConfig) {
  await configureBrowserAuth(
    browserProxyAuth({
      identityScopes: { [IDENTITY]: ["operator.admin"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto", "x-openclaw-scopes"],
        allowUsers: [IDENTITY, MEMBER, OWNER],
        allowLoopback: true,
      },
    }),
    roles ? { roles } : {},
  );
}

// A pong follows every frame the Gateway wrote to the socket before it.
const flush = (ws: WebSocket) =>
  new Promise((resolve) => {
    ws.once("pong", resolve);
    ws.ping();
  });

test("a session-scoped browser starts the main conversation without broader access", async () => {
  await configure();
  await withGatewayServer(async ({ port }) => {
    const { ws } = await connect(port, IDENTITY);
    try {
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

// The subscription is admitted while main is absent; each event is authorized when it is sent.
test("an admitted subscriber to absent main receives only what it may currently read", async () => {
  await configure(ROLES);
  await withGatewayServer(async ({ port }) => {
    const member = await connect(port, MEMBER);
    // The owner may also change sharing.
    const owner = await connect(port, OWNER, "operator.read,operator.write");
    let turns = 0;
    // The member's main-session frames written while the owner runs one turn.
    const ownerTurn = async (open = true) => {
      member.frames.length = 0;
      const turn = { sessionKey: MAIN, message: "private", idempotencyKey: `turn-${++turns}` };
      const saw = onceMessage(owner.ws, (frame) => frame.event === "session.message");
      expect((await rpcReq(owner.ws, "chat.send", turn)).ok).toBe(true);
      await saw;
      if (open) {
        await flush(member.ws);
      }
      return member.frames.map((frame) => frame.event);
    };
    try {
      const subscribe = (ws: WebSocket) => rpcReq(ws, "sessions.messages.subscribe", { key: MAIN });
      expect((await subscribe(member.ws)).ok).toBe(true);
      const draft = await rpcReq(owner.ws, "sessions.create", { key: MAIN, visibility: "draft" });
      expect(draft.ok, JSON.stringify(draft.error)).toBe(true);
      expect((await subscribe(owner.ws)).ok).toBe(true);
      // Another creator's draft main stays hidden, and its turns stay the creator's.
      expect(await ownerTurn()).toEqual([]);
      const send = { sessionKey: MAIN, message: "hi", idempotencyKey: "member-turn" };
      expect((await rpcReq(member.ws, "chat.send", send)).ok).toBe(false);
      // Control: once shared, the same subscription receives the conversation.
      const visibility = { sessionKey: MAIN, visibility: "shared" };
      const shared = await rpcReq(owner.ws, "session.visibility.set", visibility);
      expect(shared.ok, JSON.stringify(shared.error)).toBe(true);
      expect(await ownerTurn()).toContain("session.message");
      // A narrower session cap keeps the socket but stops delivery at send time.
      const memberId = ensureProfileForEmail(MEMBER).id;
      setUserProfileRole(memberId, "none");
      expect(await waitForWsClose(member.ws, 200)).toBe(false);
      expect(await ownerTurn()).toEqual([]);
      // Losing the connection's scopes closes it.
      setUserProfileRole(memberId, "denied");
      expect(await waitForWsClose(member.ws, 5_000)).toBe(true);
      expect(await ownerTurn(false)).toEqual([]);
    } finally {
      member.ws.close();
      owner.ws.close();
    }
  });
});
