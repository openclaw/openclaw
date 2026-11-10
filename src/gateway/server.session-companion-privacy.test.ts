import { afterEach, describe, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import * as companionOwner from "./session-companion.js";

installGatewayTestHooks({ scope: "suite" });
afterEach(() => vi.restoreAllMocks());
const origin = "https://control.example.com";
const sessionKey = "agent:main:private-side-chat";

// Exercise actual authentication, RPC dispatch, context reads and thread ownership.
// Only the external inference operation is synthetic; no live provider is claimed.
function useEchoInference() {
  const create = companionOwner.createSessionCompanion;
  return vi
    .spyOn(companionOwner, "createSessionCompanion")
    .mockImplementation((deps) =>
      create({ ...deps, run: async ({ messages }) => "Answer to " + messages.at(-1)!.content }),
    );
}

describe("Side chat authenticated requester privacy", () => {
  test("isolates ask/state/reset across two authenticated profiles and reconnects", async () => {
    const auth: GatewayAuthConfig = {
      mode: "trusted-proxy",
      identityScopes: {
        "alice@example.test": ["operator.admin"],
        "bob@example.test": ["operator.admin"],
      },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
      },
    };
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await writeConfigFile({
      gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
      agents: { defaults: { utilityModel: "anthropic/claude-opus-4-6" } },
    });
    useEchoInference();
    await withGatewayServer(async ({ port }) => {
      const sockets: Awaited<ReturnType<typeof openWs>>[] = [];
      const connect = async (person: string) => {
        const ws = await openWs(port, {
          origin,
          "x-forwarded-for": "203.0.113.50",
          "x-forwarded-proto": "https",
          "x-forwarded-user": person + "@example.test",
        });
        sockets.push(ws);
        const result = await connectReq(ws, {
          skipDefaultAuth: true,
          prePairDevice: true,
          client: { ...CONTROL_UI_CLIENT, instanceId: person },
          scopes: ["operator.admin"],
          browserOrigin: origin,
        });
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        return ws;
      };
      try {
        const alice = await connect("alice");
        const bob = await connect("bob");
        const created = await rpcReq(alice, "sessions.create", {
          key: sessionKey,
          visibility: "shared",
        });
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        const ask = (ws: typeof alice, question: string) =>
          rpcReq(ws, "sessions.companion.ask", { sessionKey, question });
        const state = (ws: typeof alice) => rpcReq(ws, "sessions.companion.state", { sessionKey });
        expect(await ask(alice, "Question A1")).toMatchObject({
          ok: true,
          payload: { answer: "Answer to Question A1" },
        });
        // This must be empty even before Bob asks: baseline exposes Alice's exchange here.
        expect(await state(bob)).toMatchObject({ ok: true, payload: { exchanges: [] } });
        expect(await ask(bob, "Question B1")).toMatchObject({
          ok: true,
          payload: { answer: "Answer to Question B1" },
        });
        const aliceAgain = await connect("alice");
        expect(await state(aliceAgain)).toMatchObject({
          ok: true,
          payload: { exchanges: [{ question: "Question A1" }] },
        });
        expect(await state(bob)).toMatchObject({
          ok: true,
          payload: { exchanges: [{ question: "Question B1" }] },
        });
        expect(await rpcReq(bob, "sessions.companion.reset", { sessionKey })).toMatchObject({
          ok: true,
        });
        expect(await state(bob)).toMatchObject({ ok: true, payload: { exchanges: [] } });
        expect(await state(alice)).toMatchObject({
          ok: true,
          payload: { exchanges: [{ question: "Question A1" }] },
        });
      } finally {
        for (const ws of sockets) {
          ws.close();
        }
      }
    });
  });

  test("keeps shared-token connections in one shared principal", async () => {
    testState.agentConfig = { utilityModel: "anthropic/claude-opus-4-6" };
    useEchoInference();
    await withGatewayServer(async ({ port }) => {
      const first = await openWs(port);
      const second = await openWs(port);
      try {
        expect((await connectReq(first)).ok).toBe(true);
        expect((await connectReq(second)).ok).toBe(true);
        expect(
          (await rpcReq(first, "sessions.create", { key: sessionKey, visibility: "shared" })).ok,
        ).toBe(true);
        expect(
          await rpcReq(first, "sessions.companion.ask", {
            sessionKey,
            question: "Shared question",
          }),
        ).toMatchObject({ ok: true });
        expect(await rpcReq(second, "sessions.companion.state", { sessionKey })).toMatchObject({
          ok: true,
          payload: { exchanges: [{ question: "Shared question" }] },
        });
        expect((await rpcReq(second, "sessions.companion.reset", { sessionKey })).ok).toBe(true);
        expect(await rpcReq(first, "sessions.companion.state", { sessionKey })).toMatchObject({
          ok: true,
          payload: { exchanges: [] },
        });
      } finally {
        first.close();
        second.close();
      }
    });
  });
});
