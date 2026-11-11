import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
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
  let configure: (() => Promise<boolean>) | undefined;
  let connect: (() => Promise<void>) | undefined;
  let transcribeImmediately = true;
  const createSession = vi.fn(
    (
      request: import("../realtime-transcription/provider-contexts.js").RealtimeTranscriptionSessionCreateRequest,
    ) => ({
      connect: () => connect?.() ?? Promise.resolve(),
      sendAudio: () => {
        receivedAudio += 1;
        if (transcribeImmediately) {
          request.onTranscript?.("guest dictation transcript");
        }
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
      isConfiguredAsync: () => configure?.() ?? Promise.resolve(true),
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
      let generation = 0;
      const revokeSession = () =>
        deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveDefaultSessionStorePath("main"),
          target: { canonicalKey: ownKey, storeKeys: [ownKey] },
          archiveTranscript: false,
        });
      const replaceSession = async (owner: string) => {
        await revokeSession();
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: ownKey },
          {
            sessionId: `dictation-generation-${++generation}`,
            updatedAt: Date.now(),
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: owner },
            visibility: "shared",
          },
        );
      };
      const start = () =>
        rpcReq<{ sessionId: string }>(ws, "talk.session.create", {
          sessionKey: ownKey,
          mode: "transcription",
          transport: "gateway-relay",
          brain: "none",
        });
      // Changing the canonical owner during provider discovery must prevent
      // provider creation, not merely reject a later append request.
      const configuring = Promise.withResolvers<void>();
      const configured = Promise.withResolvers<boolean>();
      configure = () => {
        configuring.resolve();
        return configured.promise;
      };
      const pendingStartup = start();
      await configuring.promise;
      await replaceSession(other.id);
      configured.resolve(true);
      expect((await pendingStartup).ok).toBe(false);
      expect(createSession).toHaveBeenCalledTimes(1);
      configure = undefined;
      await replaceSession(guest.id);

      // Session access does not grant access to another connection's relay.
      const foreign = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.8",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "dictation@example.com",
      });
      try {
        expect(
          (
            await connectReq(foreign, {
              skipDefaultAuth: true,
              prePairDevice: true,
              scopes: ["operator.sessions.write"],
              client: CONTROL_UI_CLIENT,
              deviceIdentityPath: path.join(identityDir, "foreign", "client", "credentials.sqlite"),
            })
          ).ok,
        ).toBe(true);
        expect((await rpcReq(foreign, "talk.catalog", { sessionKey: ownKey })).ok).toBe(true);
        const owned = await start();
        expect(owned.ok).toBe(true);
        expect(
          (
            await rpcReq(foreign, "talk.session.appendAudio", {
              sessionId: owned.payload!.sessionId,
              audioBase64: "AAA=",
            })
          ).ok,
        ).toBe(false);
        expect(receivedAudio).toBe(1);
        expect(
          (
            await rpcReq(ws, "talk.session.close", {
              sessionId: owned.payload!.sessionId,
            })
          ).ok,
        ).toBe(true);
      } finally {
        foreign.terminate();
      }

      const delivered: string[] = [];
      const collect = (data: Parameters<typeof rawDataToString>[0]) => {
        delivered.push(rawDataToString(data));
      };
      ws.on("message", collect);
      try {
        // The RPC returns while connect is pending. Neither readiness nor a
        // late transcript may escape after the session owner changes.
        const connecting = Promise.withResolvers<void>();
        const connected = Promise.withResolvers<void>();
        connect = () => {
          connecting.resolve();
          return connected.promise;
        };
        const delayed = await start();
        expect(delayed.ok).toBe(true);
        await connecting.promise;
        const pendingProvider = createSession.mock.calls.at(-1)![0];
        await replaceSession(other.id);
        delivered.length = 0;
        connected.resolve();
        pendingProvider.onTranscript!("invalid startup transcript");
        await rpcReq(ws, "talk.config", {});
        expect(delivered.join(" ")).not.toContain("invalid startup transcript");
        expect(delivered.join(" ")).not.toContain('"type":"session.ready"');
        expect(
          (
            await rpcReq(ws, "talk.session.appendAudio", {
              sessionId: delayed.payload!.sessionId,
              audioBase64: "AAA=",
            })
          ).ok,
        ).toBe(false);
        expect(receivedAudio).toBe(1);
        connect = undefined;
        await replaceSession(guest.id);

        transcribeImmediately = false;
        const transcribing = await start();
        expect(transcribing.ok).toBe(true);
        expect(
          (
            await rpcReq(ws, "talk.session.appendAudio", {
              sessionId: transcribing.payload!.sessionId,
              audioBase64: "AAA=",
            })
          ).ok,
        ).toBe(true);
        expect(receivedAudio).toBe(2);
        const pendingTranscript = createSession.mock.calls.at(-1)![0];
        await revokeSession();
        expect(
          (
            await rpcReq(ws, "talk.session.appendAudio", {
              sessionId: transcribing.payload!.sessionId,
              audioBase64: "AAA=",
            })
          ).ok,
        ).toBe(false);
        expect(receivedAudio).toBe(2);
        delivered.length = 0;
        pendingTranscript.onTranscript!("reassigned session transcript");
        pendingTranscript.onPartial?.("reassigned session partial");
        // This round trip is a delivery barrier, not a timer-based absence check.
        await rpcReq(ws, "talk.config", {});
        expect(delivered.join(" ")).not.toContain("reassigned session transcript");
        expect(delivered.join(" ")).not.toContain("reassigned session partial");
        await replaceSession(guest.id);
        transcribeImmediately = true;
      } finally {
        ws.off("message", collect);
      }
      const revoked = await rpcReq(ws, "talk.session.create", {
        sessionKey: ownKey,
        mode: "transcription",
      });
      expect(revoked.ok).toBe(true);
      const afterRevocation: string[] = [];
      ws.on("message", (data) => afterRevocation.push(rawDataToString(data)));
      setUserProfileRole(guest.id, "none");
      expect(createSession).toHaveBeenCalledTimes(5);
      createSession.mock.calls.at(-1)![0].onTranscript!("revoked dictation must not be delivered");
      expect(await waitForWsClose(ws, 3000)).toBe(true);
      expect(afterRevocation.join(" ")).not.toContain("revoked dictation must not be delivered");
    } finally {
      ws.terminate();
    }
  });
}, 30_000);
