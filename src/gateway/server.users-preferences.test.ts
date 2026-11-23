import { expect, test } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  browserProxyAuth,
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("named preferences stay profile-scoped over authenticated multi-agent Gateway RPC", async () => {
  const origin = "https://preferences.example.test";
  const scopes: OperatorScope[] = ["operator.read", "operator.write"];
  const controlUi = { allowedOrigins: [origin] };
  const readerRole = { agents: "*" as const, scopes, sessions: { others: "none" as const } };
  const auth = browserProxyAuth();
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = controlUi;
  await writeConfigFile(
    {
      agents: { ownership: "explicit", entries: { research: {}, review: {} } },
      gateway: {
        auth,
        trustedProxies: ["127.0.0.1"],
        controlUi,
        roles: { default: "reader", definitions: { reader: readerRole } },
      },
    },
    { allowedAgentRosterRemovals: ["main"] },
  );
  await withGatewayServer(async ({ port }) => {
    const headers = {
      origin,
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "preferences-reader@example.test",
    };
    const socket = await openWs(port, headers);
    const nativeSockets: (typeof socket)[] = [];
    try {
      const connected = await connectReq(socket, {
        skipDefaultAuth: true,
        client: CONTROL_UI_CLIENT,
        caps: ["personal-session-pins"],
        prePairDevice: true,
        scopes,
        browserOrigin: origin,
      });
      expect(connected, JSON.stringify(connected.error)).toMatchObject({
        ok: true,
        payload: { auth: { method: "trusted-proxy", scopes } },
      });
      const privateKey = "agent:research:dashboard:incognito-preference";
      const entries = { "ui.theme": "dark", [privateKey]: "personal" };
      const reader = ensureProfileForEmail("preferences-reader@example.test");
      expect(await rpcReq(socket, "users.prefs.set", { entries })).toMatchObject({ ok: true });
      expect(await rpcReq(socket, "users.prefs.get", {})).toMatchObject({
        ok: true,
        payload: { status: "ok", entries },
      });
      expect.soft(await rpcReq(socket, "users.prefs.get", { keys: [privateKey] })).toMatchObject({
        ok: true,
        payload: { status: "ok", entries: { [privateKey]: "personal" } },
      });
      const foreign = ensureProfileForEmail("foreign-owner@example.test");
      const denied = { ok: false, error: { code: "INVALID_REQUEST" } };
      for (const [name, owner, expected] of [
        ["own", reader, { ok: true }],
        ["foreign", foreign, denied],
      ] as const) {
        const key = `agent:research:${name}`;
        await upsertSessionEntryCore(
          { agentId: "research", sessionKey: key },
          {
            sessionId: `${name}-session`,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: owner.id },
          },
        );
        expect(await rpcReq(socket, "sessions.preview", { keys: [key] })).toMatchObject(expected);
      }
      const rail = "ui.railShortcuts";
      const own = "agent:research:own";
      const foreignKey = "agent:research:foreign";
      const layout = [`session:${foreignKey}`, `session-rail:${own}`, `session:${own}`];
      expect(
        await rpcReq(socket, "users.prefs.set", { entries: { [rail]: layout } }),
      ).toMatchObject({ ok: true, payload: { status: "ok" } });
      const list = await rpcReq(socket, "sessions.list", { pinned: true, agentId: "research" });
      expect(list).toMatchObject({
        ok: true,
        payload: { totalCount: 1, sessions: [{ key: own, pinned: true }] },
      });
      expect(
        await rpcReq(socket, "sessions.patch", {
          key: own,
          expectedSessionId: "own-session",
          pinned: false,
        }),
      ).toMatchObject({
        ok: true,
        payload: { entry: { sessionId: "own-session", pinned: false } },
      });
      const after = await rpcReq(socket, "users.prefs.get", { keys: [rail] });
      expect(after).toMatchObject({
        ok: true,
        payload: { status: "ok", entries: { [rail]: layout.slice(0, 2) } },
      });
      // Both native handshakes belong to the same person. Only the negotiated wire contract differs.
      const connectNative = async (personal: boolean) => {
        const ws = await openWs(port, headers);
        nativeSockets.push(ws);
        const reply = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          scopes,
          client: { id: "openclaw-android", mode: "ui", platform: "android", version: "1.0.0" },
          caps: personal ? ["personal-session-pins"] : [],
        });
        expect(reply, JSON.stringify(reply.error)).toMatchObject({
          ok: true,
          payload: {
            auth: { method: "trusted-proxy" },
            features: { capabilities: expect.arrayContaining(["personal-session-pins"]) },
          },
        });
        expect(await rpcReq(ws, "sessions.subscribe", {})).toMatchObject({ ok: true });
        return ws;
      };
      const personal = await connectNative(true);
      const legacy = await connectNative(false);
      const rowChanged = (ws: typeof socket) =>
        onceMessage(
          ws,
          (frame) =>
            frame.event === "sessions.changed" &&
            frame.payload?.sessionKey === own &&
            frame.payload?.reason === "patch",
        );
      const [currentEvent, historicalEvent, historicalWrite] = await Promise.all([
        rowChanged(personal),
        rowChanged(legacy),
        rpcReq(legacy, "sessions.patch", { key: own, pinned: true }),
      ]);
      expect(historicalWrite).toMatchObject({ ok: true });
      expect(historicalEvent.payload).toMatchObject({
        pinned: true,
        session: { key: own, pinned: true },
      });
      expect(currentEvent.payload).toMatchObject({ session: { key: own } });
      for (const field of ["pinned", "pinnedAt", "session.pinned", "session.pinnedAt"]) {
        expect(currentEvent.payload).not.toHaveProperty(field);
      }
      const readHistory = (ws: typeof socket) =>
        rpcReq(ws, "chat.history", { sessionKey: own, agentId: "research", limit: 1 });
      expect(await readHistory(legacy)).toMatchObject({
        ok: true,
        payload: { sessionInfo: { key: own, pinned: true } },
      });
      const history = await readHistory(personal);
      expect(history).toMatchObject({ ok: true, payload: { sessionInfo: { key: own } } });
      expect(history.payload?.sessionInfo).not.toHaveProperty("pinned");
      expect(history.payload?.sessionInfo).not.toHaveProperty("pinnedAt");
      const roster = () => rpcReq(personal, "sessions.list", { pinned: true, agentId: "research" });
      expect(await roster()).toMatchObject({ ok: true, payload: { totalCount: 0, sessions: [] } });
      const [notification, personalWrite] = await Promise.all([
        onceMessage(personal, (frame) => frame.event === "users.prefs.changed"),
        rpcReq(socket, "sessions.patch", { key: own, pinned: true }),
      ]);
      expect(personalWrite).toMatchObject({ ok: true });
      expect(notification.payload).toMatchObject({ profileId: reader.id, keys: [rail] });
      expect(await roster()).toMatchObject({
        ok: true,
        payload: { totalCount: 1, sessions: [{ key: own, pinned: true }] },
      });
    } finally {
      for (const ws of nativeSockets) {
        ws.close();
      }
      socket.close();
    }
  });
});
