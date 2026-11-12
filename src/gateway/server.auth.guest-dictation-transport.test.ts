import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import { resolveDefaultSessionStorePath } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createRealtimeTranscriptionWebSocketSession } from "../realtime-transcription/websocket-session.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";
import { setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

test("guest revocation and discard do not flush queued audio or gracefully finalize the vendor stream", async () => {
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
        },
      },
    },
  });
  const guest = ensureProfileForEmail("dictation@example.com");
  setUserProfileRole(guest.id, "guest");
  const guestProfileId = guest.id;
  const vendor = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    vendor.once("listening", resolve);
  });
  const address = vendor.address();
  if (typeof address === "string" || address === null) {
    throw new Error("expected local vendor port");
  }
  type VendorConnection = { socket: WebSocket; frames: unknown[]; closed: Promise<void> };
  let nextVendor = Promise.withResolvers<VendorConnection>();
  let holdReady = false;
  vendor.on("connection", (socket) => {
    const frames: unknown[] = [];
    const closed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as { type: string };
      frames.push(frame);
      if (frame.type === "audio.done") {
        socket.send(JSON.stringify({ type: "transcript.done" }));
      }
    });
    nextVendor.resolve({ socket, frames, closed });
    if (!holdReady) {
      socket.send(JSON.stringify({ type: "ready" }));
    }
  });
  const registry = createEmptyPluginRegistry();
  registry.realtimeTranscriptionProviders.push({
    pluginId: "dictation-wire",
    source: "test",
    provider: {
      id: "dictation-wire",
      label: "Dictation wire fixture",
      isConfigured: () => true,
      createSession: (callbacks) =>
        createRealtimeTranscriptionWebSocketSession<{ type: string }>({
          providerId: "dictation-wire",
          callbacks,
          url: `ws://127.0.0.1:${address.port}`,
          reconnectDelayMs: 1,
          sendAudio: (audio, transport) => {
            transport.sendJson({ type: "audio", data: audio.toString("base64") });
          },
          // Match providers such as xAI: ordinary close finalizes buffered speech.
          onClose: (transport) => {
            transport.sendJson({ type: "audio.done" });
            return true;
          },
          onMessage: (event, transport) => {
            if (event.type === "ready") {
              transport.markReady();
            }
            if (event.type === "transcript") {
              transport.callbacks.onTranscript?.("authority probe");
            }
            if (event.type === "transcript.done") {
              transport.closeNow();
            }
          },
        }),
    },
  });
  setTestPluginRegistry(registry);
  const identityDir = tempDirs.make("openclaw-guest-dictation-wire-");
  try {
    await withGatewayServer(async ({ port }) => {
      const sessionKey = "agent:main:guest-dictation-wire";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "guest-dictation-wire",
          updatedAt: Date.now(),
          createdVia: "operator",
          createdActor: { type: "human", source: "profile", id: guestProfileId },
          visibility: "shared",
        },
      );
      const ws = await openWs(port, {
        origin,
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "dictation@example.com",
      });
      try {
        expect(
          (
            await connectReq(ws, {
              skipDefaultAuth: true,
              prePairDevice: true,
              scopes: ["operator.sessions.write"],
              client: CONTROL_UI_CLIENT,
              deviceIdentityPath: path.join(identityDir, "client", "credentials.sqlite"),
            })
          ).ok,
        ).toBe(true);
        const start = async () => {
          nextVendor = Promise.withResolvers<VendorConnection>();
          const created = await rpcReq<{ sessionId: string }>(ws, "talk.session.create", {
            sessionKey,
            mode: "transcription",
            transport: "gateway-relay",
            brain: "none",
          });
          expect(created.ok).toBe(true);
          return { sessionId: created.payload!.sessionId, wire: await nextVendor.promise };
        };
        // Positive control: both audio and a graceful finish cross the actual wire.
        const allowed = await start();
        expect(
          (
            await rpcReq(ws, "talk.session.appendAudio", {
              sessionId: allowed.sessionId,
              audioBase64: "AQI=",
            })
          ).ok,
        ).toBe(true);
        expect((await rpcReq(ws, "talk.session.close", { sessionId: allowed.sessionId })).ok).toBe(
          true,
        );
        await allowed.wire.closed;
        expect(allowed.wire.frames).toEqual([
          { type: "audio", data: "AQI=" },
          { type: "audio.done" },
        ]);

        const discarded = await start();
        expect(
          (
            await rpcReq(ws, "talk.session.close", {
              sessionId: discarded.sessionId,
              discard: true,
            })
          ).ok,
        ).toBe(true);
        await discarded.wire.closed;
        expect.soft(discarded.wire.frames, "discard must not finalize provider speech").toEqual([]);

        const revoked = await start();
        // A reconnect is a real queueing window: the existing relay remains usable
        // while the replacement provider socket waits for its ready frame.
        holdReady = true;
        nextVendor = Promise.withResolvers<VendorConnection>();
        revoked.wire.socket.close(1012, "replace stream");
        await revoked.wire.closed;
        const replacement = await nextVendor.promise;
        expect(
          (
            await rpcReq(ws, "talk.session.appendAudio", {
              sessionId: revoked.sessionId,
              audioBase64: "AwQ=",
            })
          ).ok,
        ).toBe(true);
        await deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveDefaultSessionStorePath("main"),
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
          archiveTranscript: false,
        });
        replacement.socket.send(JSON.stringify({ type: "ready" }));
        // Ordered behind readiness, this callback forces even the old relay to
        // observe revocation. The close barrier includes every preceding frame.
        replacement.socket.send(JSON.stringify({ type: "transcript" }));
        await replacement.closed;
        expect(replacement.frames, "revoked buffered audio must never reach the provider").toEqual(
          [],
        );
      } finally {
        ws.terminate();
      }
    });
  } finally {
    for (const socket of vendor.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      vendor.close((error) => (error ? reject(error) : resolve()));
    });
  }
}, 30_000);
