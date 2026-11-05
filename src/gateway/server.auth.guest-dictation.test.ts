import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  onceMessage,
  openWs,
  rpcReq,
  testState,
  waitForWsClose,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("guest dictation crosses the real WebSocket authorization boundary", async () => {
  const origin = "https://control.example.com";
  const auth: GatewayAuthConfig = {
    mode: "trusted-proxy",
    identityScopes: { "dictation@example.com": ["operator.sessions.write"] },
    trustedProxy: {
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowLoopback: true,
    },
  };
  testState.gatewayAuth = auth;
  testState.gatewayControlUi = { allowedOrigins: [origin] };
  await writeConfigFile({
    gateway: {
      auth,
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [origin] },
      roles: {
        default: "guest",
        definitions: {
          guest: { sessions: { others: "view" }, agents: "*", scopes: ["operator.sessions.write"] },
          none: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      },
    },
  });
  const guest = ensureProfileForEmail("dictation@example.com");
  const other = ensureProfileForEmail("other-dictation@example.com");
  setUserProfileRole(guest.id, "guest");
  setUserProfileRole(other.id, "guest");
  const close = vi.fn();
  let receivedAudio = 0;
  const createSession = vi.fn(
    (
      request: import("../realtime-transcription/provider-contexts.js").RealtimeTranscriptionSessionCreateRequest,
    ) => ({
      connect: async () => {},
      sendAudio: () => {
        receivedAudio += 1;
        request.onTranscript?.("guest dictation transcript");
      },
      close,
      isConnected: () => true,
    }),
  );
  const registry = createEmptyPluginRegistry();
  registry.realtimeTranscriptionProviders.push({
    pluginId: "dictation-fixture",
    source: "test",
    provider: {
      id: "dictation-fixture",
      label: "Dictation fixture",
      isConfigured: () => true,
      createSession,
    },
  });
  setTestPluginRegistry(registry);
  const identityDir = tempDirs.make("openclaw-guest-dictation-");
  await withGatewayServer(async ({ port }) => {
    const ownKey = "agent:main:guest-dictation-websocket";
    const otherKey = "agent:main:other-dictation-websocket";
    for (const [sessionKey, owner] of [
      [ownKey, guest.id],
      [otherKey, other.id],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey.split(":").at(-1)!,
          updatedAt: Date.now(),
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: owner },
          visibility: "shared",
        },
      );
    }
    const ws = await openWs(port, {
      origin,
      "x-forwarded-for": "203.0.113.7",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "dictation@example.com",
    });
    try {
      const hello = await connectReq(ws, {
        skipDefaultAuth: true,
        prePairDevice: true,
        scopes: ["operator.sessions.write"],
        client: CONTROL_UI_CLIENT,
        deviceIdentityPath: path.join(identityDir, "client", "credentials.sqlite"),
      });
      expect(hello.ok).toBe(true);
      expect(hello.payload).toMatchObject({
        auth: { scopes: ["operator.sessions.write"] },
        features: {
          methods: expect.arrayContaining([
            "talk.catalog",
            "talk.session.create",
            "talk.session.appendAudio",
            "talk.session.close",
          ]),
        },
      });
      let catalogResponse: unknown;
      try {
        await vi.waitFor(
          async () => {
            const catalog = await rpcReq(ws, "talk.catalog", { sessionKey: ownKey });
            catalogResponse = catalog;
            expect(catalog.ok).toBe(true);
            expect(catalog.payload).toEqual({
              modes: ["transcription"],
              transports: ["gateway-relay"],
              brains: ["none"],
              transcription: { ready: true, providers: [] },
              realtime: { ready: false, providers: [] },
              speech: { ready: false, providers: [] },
            });
          },
          { timeout: 5000 },
        );
      } catch (error) {
        throw new Error(
          `Dictation catalog did not become ready: ${JSON.stringify(catalogResponse)}`,
          { cause: error },
        );
      }
      expect((await rpcReq(ws, "talk.config", {})).ok).toBe(false);
      expect(
        (await rpcReq(ws, "talk.session.create", { sessionKey: otherKey, mode: "transcription" }))
          .ok,
      ).toBe(false);
      const created = await rpcReq<{ sessionId: string }>(ws, "talk.session.create", {
        sessionKey: ownKey,
        mode: "transcription",
        transport: "gateway-relay",
        brain: "none",
      });
      expect(created.ok).toBe(true);
      const sessionId = created.payload!.sessionId;
      const transcript = onceMessage<{
        type: "event";
        event: string;
        payload: { text?: string; final?: boolean };
      }>(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "talk.event" &&
          message.payload?.text === "guest dictation transcript",
      );
      expect(
        (await rpcReq(ws, "talk.session.appendAudio", { sessionId, audioBase64: "AAA=" })).ok,
      ).toBe(true);
      expect((await transcript).payload).toMatchObject({
        text: "guest dictation transcript",
        final: true,
      });
      expect(receivedAudio).toBe(1);
      expect((await rpcReq(ws, "talk.session.close", { sessionId })).ok).toBe(true);
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      const revoked = await rpcReq(ws, "talk.session.create", {
        sessionKey: ownKey,
        mode: "transcription",
      });
      expect(revoked.ok).toBe(true);
      const afterRevocation: string[] = [];
      ws.on("message", (data) => afterRevocation.push(rawDataToString(data)));
      setUserProfileRole(guest.id, "none");
      expect(createSession).toHaveBeenCalledTimes(2);
      createSession.mock.calls[1]![0].onTranscript!("revoked dictation must not be delivered");
      expect(await waitForWsClose(ws, 3000)).toBe(true);
      expect(afterRevocation.join(" ")).not.toContain("revoked dictation must not be delivered");
    } finally {
      ws.terminate();
    }
  });
}, 30_000);
