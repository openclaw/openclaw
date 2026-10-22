import { expect, test } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
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
  const auth = {
    mode: "trusted-proxy" as const,
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
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
    const socket = await openWs(port, {
      origin,
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "preferences-reader@example.test",
    });
    try {
      const connected = await connectReq(socket, {
        skipDefaultAuth: true,
        client: CONTROL_UI_CLIENT,
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
    } finally {
      socket.close();
    }
  });
});
