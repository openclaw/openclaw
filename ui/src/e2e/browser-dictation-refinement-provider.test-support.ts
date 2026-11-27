import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { WebSocketServer } from "ws";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";

type SpeechAttempt = {
  audioBytes: number;
  finishing: boolean;
  closed: boolean;
  release: (text: string) => void;
};

/** Fixed speech-service I/O; the real plugin, Gateway relay and browser own finalization. */
export async function startDictationSpeechProvider() {
  const realtime: SpeechAttempt[] = [];
  const files: SpeechAttempt[] = [];
  const unexpected: string[] = [];
  const upstream = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void buffer(request)
          .then((body) => {
            const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
            if (request.method === "POST" && pathname === "/v1/listen") {
              const attempt: SpeechAttempt = {
                audioBytes: body.length,
                finishing: true,
                closed: false,
                release: (text) => {
                  response.writeHead(200, { "content-type": "application/json" });
                  response.end(
                    JSON.stringify({
                      results: { channels: [{ alternatives: [{ transcript: text }] }] },
                    }),
                  );
                },
              };
              // The production file adapter must actually encode the microphone frames.
              if (
                body.subarray(0, 4).toString() !== "RIFF" ||
                body.subarray(8, 12).toString() !== "WAVE"
              ) {
                unexpected.push("invalid-wave-upload");
                response.writeHead(400).end();
                return;
              }
              response.on("close", () => {
                attempt.closed = true;
              });
              files.push(attempt);
            } else if (request.method === "POST" && pathname === "/v1/responses") {
              writeOpenAiResponsesText(response, {
                text: "Dictation review",
                messageId: "dictation-metadata",
                responseId: "dictation-metadata-response",
              });
            } else if (request.method === "GET" && pathname === "/v1/models") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ data: [{ id: "metadata" }] }));
            } else {
              unexpected.push(`${request.method} ${pathname}`);
              response.writeHead(404).end();
            }
          })
          .catch(() => {
            if (!response.destroyed) {
              response.writeHead(400).end();
            }
          });
      }),
  });
  const sockets = new WebSocketServer({ server: upstream.listener, path: "/v1/listen" });
  sockets.on("connection", (socket) => {
    const attempt: SpeechAttempt = {
      audioBytes: 0,
      finishing: false,
      closed: false,
      release: (text) =>
        socket.send(
          JSON.stringify({
            type: "Results",
            is_final: true,
            from_finalize: true,
            channel: { alternatives: [{ transcript: text }] },
          }),
        ),
    };
    realtime.push(attempt);
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const first = attempt.audioBytes === 0;
        attempt.audioBytes += Array.isArray(data)
          ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
          : data.byteLength;
        if (first) {
          socket.send(
            JSON.stringify({
              type: "Results",
              is_final: false,
              channel: { alternatives: [{ transcript: "Do not" }] },
            }),
          );
        }
      } else if (JSON.parse(rawDataToString(data)).type === "Finalize") {
        attempt.finishing = true;
      }
    });
    socket.on("close", () => {
      attempt.closed = true;
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${upstream.claim.port}/v1`,
    realtime,
    files,
    unexpected,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        sockets.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await closed;
      upstream.listener.closeAllConnections();
      await upstream.releaseListener();
      await upstream.claim.release();
    },
  };
}
