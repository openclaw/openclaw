import { X509Certificate } from "node:crypto";
import dns from "node:dns";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "../../packages/gateway-client/src/websocket.test-support.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { runTtsConvert } from "./capability-cli/tts-runtime.js";

it("negotiates remote TTS before synthesis and preserves legacy and failed output", async () => {
  await withOpenClawTestState(
    {
      scenario: "minimal",
      env: {
        OPENCLAW_GATEWAY_URL: undefined,
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
      },
    },
    async (state) => {
      const claim = await acquireTestPortBlock({ offsets: [0] });
      const server = createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM });
      const wss = new WebSocketServer({ server });
      let listening = false;
      const sockets = new Set<Socket>();
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });
      // Only external DNS resolution is substituted. The selected remote origin,
      // TLS fingerprint, Gateway client, capability gate, and output writer are real.
      const originalLookup = dns.lookup;
      const resolver = vi.spyOn(dns, "lookup").mockImplementation(
        new Proxy(originalLookup, {
          apply(target, receiver, args) {
            const [hostname, ...rest] = args;
            return Reflect.apply(target, receiver, [
              hostname === "tts.example.test" ? "127.0.0.1" : hostname,
              ...rest,
            ]);
          },
        }),
      );
      let supportsInline = false;
      let malformed = false;
      const requests: Array<Record<string, unknown>> = [];
      const audio = Buffer.from("RIFF synthetic remote TTS bytes");
      wss.on("connection", (ws) => {
        sendMinimalGatewayConnectChallenge(ws);
        ws.on("message", (raw) => {
          const frame = parseMinimalGatewayRequestFrame(raw);
          if (!frame.id || frame.type !== "req") {
            return;
          }
          if (frame.method === "connect") {
            const hello = buildMinimalGatewayHelloOkPayload({ methods: ["tts.convert"] });
            sendMinimalGatewayResponse(ws, frame.id, {
              ...hello,
              features: {
                ...hello.features,
                ...(supportsInline ? { capabilities: ["tts-convert-inline-audio-v1"] } : {}),
              },
            });
          } else if (frame.method === "tts.convert") {
            requests.push(frame.params ?? {});
            sendMinimalGatewayResponse(ws, frame.id, {
              audioPath: "/server-only/speech.wav",
              ...(supportsInline
                ? { audioBase64: malformed ? "not-base64!" : audio.toString("base64") }
                : {}),
              provider: "fixture",
              outputFormat: "wav",
              voiceCompatible: false,
            });
          }
        });
      });
      try {
        const ready = once(server, "listening");
        server.listen(claim.port, "127.0.0.1");
        await ready;
        listening = true;
        const config: OpenClawConfig = {
          gateway: {
            mode: "remote",
            remote: {
              url: `wss://tts.example.test:${claim.port}`,
              token: "synthetic-tts-wire-token",
              tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
            },
          },
        };
        await state.writeConfig(config);
        setRuntimeConfigSnapshot(config);
        const output = state.path("speech.wav");
        await fs.writeFile(output, "existing-speech");
        const convert = () =>
          runTtsConvert({
            transport: "gateway",
            text: "synthetic proof",
            provider: "fixture",
            voiceId: "fixture-voice",
            output,
          });

        let unsupportedError: unknown;
        try {
          await convert();
        } catch (error) {
          unsupportedError = error;
        }
        expect
          .soft(String(unsupportedError))
          .toContain('required capability "tts-convert-inline-audio-v1"');
        expect.soft(requests).toHaveLength(0);
        expect.soft(await fs.readFile(output, "utf8")).toBe("existing-speech");
        console.log(
          "REMOTE_TTS_OLD_PEER",
          JSON.stringify({
            synthesisRequests: requests.length,
            preserved: (await fs.readFile(output, "utf8")) === "existing-speech",
          }),
        );

        requests.length = 0;
        supportsInline = true;
        const result = await convert();
        expect(requests).toEqual([
          expect.objectContaining({
            text: "synthetic proof",
            provider: "fixture",
            voiceId: "fixture-voice",
            includeAudio: true,
          }),
        ]);
        expect(await fs.readFile(output)).toEqual(audio);
        expect(result.outputs).toEqual([{ path: output, format: "wav", voiceCompatible: false }]);
        console.log(
          "REMOTE_TTS_SUPPORTED_PEER",
          JSON.stringify({ synthesisRequests: requests.length, bytesVerified: audio.length }),
        );

        requests.length = 0;
        malformed = true;
        await expect(convert()).rejects.toThrow("invalid inline TTS audio");
        expect(requests).toHaveLength(1);
        expect(await fs.readFile(output)).toEqual(audio);
        console.log(
          "REMOTE_TTS_INVALID_PEER",
          JSON.stringify({ synthesisRequests: requests.length, previousBytesPreserved: true }),
        );

        requests.length = 0;
        supportsInline = false;
        const legacy = await runTtsConvert({ transport: "gateway", text: "legacy path-only" });
        expect(requests).toHaveLength(1);
        expect(requests[0]).not.toHaveProperty("includeAudio");
        expect(legacy.outputs[0]?.path).toBe("/server-only/speech.wav");
        console.log(
          "REMOTE_TTS_PATH_ONLY",
          JSON.stringify({ synthesisRequests: requests.length, inlineRequested: false }),
        );
      } finally {
        clearRuntimeConfigSnapshot();
        resolver.mockRestore();
        for (const socket of sockets) {
          socket.destroy();
        }
        await closeMinimalGatewayServer(wss);
        if (listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
        await claim.release();
      }
    },
  );
}, 30_000);
