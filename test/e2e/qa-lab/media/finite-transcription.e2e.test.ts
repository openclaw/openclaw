// Process-boundary proof: a loaded consumer invokes the built host and bundled ElevenLabs adapter.
import { writeSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { createDeferred } from "../../../helpers/promise.js";
import { useMediaGateway } from "./media-gateway.test-support.js";

const proof = useMediaGateway();
const pluginId = "finite-gateway-proof";
const consumer = `
export default {
  id: "finite-gateway-proof",
  register(api) {
    let controller;
    api.registerGatewayMethod("finite-proof.cancel", ({ respond }) => {
      controller?.abort(new Error("Synthetic caller cancellation"));
      respond(true, { canceled: true });
    });
    api.registerGatewayMethod("finite-proof.transcribe", async ({ params, respond }) => {
      controller = new AbortController();
      const signal = controller.signal;
      let inputEnded = false;
      const origin = api.config.models.providers.elevenlabs.baseUrl;
      async function* audio() {
        yield Buffer.alloc(32000, 1);
        // The test releases this only after the first frame reaches the provider socket.
        await fetch(origin + "/input-gate", { signal });
        for (let index = 1; index < 9; index += 1) yield Buffer.alloc(32000, index + 1);
        inputEnded = true;
      }
      try {
        const transcribe = api.runtime.mediaUnderstanding.transcribeAudioStream;
        if (!transcribe) throw new Error("Built host lacks the finite runtime capability");
        const result = await transcribe({
          cfg: api.config, agentId: "main", audio: audio(),
          format: { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 }, signal,
        });
        respond(true, { result, inputEnded, gatewayPid: process.pid });
      } catch (error) {
        if (signal.aborted) respond(true, { canceled: true, inputEnded });
        else respond(false, undefined, { code: "UNAVAILABLE", message: String(error) });
      }
    });
  },
};
`;

it(
  "streams and cancels through a loaded plugin in the built Gateway",
  { timeout: 240_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "finite-gateway-consumer-"));
    proof.track(() => rm(directory, { recursive: true, force: true }));
    await Promise.all([
      writeFile(path.join(directory, "index.js"), consumer),
      writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" })),
      writeFile(
        path.join(directory, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          activation: { onStartup: true },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        }),
      ),
    ]);
    const makeObservation = () => ({
      frames: [] as Buffer[],
      commits: [] as number[],
      firstAudio: createDeferred(),
      gateArrived: createDeferred(),
      closed: createDeferred(),
      gate: undefined as ServerResponse | undefined,
    });
    const complete = makeObservation();
    const canceled = makeObservation();
    let current = complete;
    let unexpectedHttp = 0;
    let connections = 0;
    const reserved = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.url === "/input-gate") {
            current.gate = response;
            current.gateArrived.resolve();
          } else {
            unexpectedHttp += 1;
            response.writeHead(500).end("Unexpected batch request");
          }
        }),
    });
    const server = reserved.listener;
    const wss = new WebSocketServer({ server });
    proof.track(async () => {
      complete.gate?.end();
      canceled.gate?.end();
      for (const socket of wss.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      server.closeAllConnections();
      await reserved.releaseListener();
      await reserved.claim.release();
    });
    wss.on("connection", (socket) => {
      const observation = current;
      connections += 1;
      socket.once("close", () => observation.closed.resolve());
      socket.send(JSON.stringify({ message_type: "session_started" }));
      socket.on("message", (data) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        const frame = JSON.parse(bytes.toString()) as { audio_base_64: string; commit: boolean };
        if (frame.commit) {
          observation.commits.push(Buffer.concat(observation.frames).length);
          socket.send(
            JSON.stringify({
              message_type: "committed_transcript",
              text: observation.commits.length === 1 ? "First segment." : "Final starlight.",
            }),
          );
        } else {
          observation.frames.push(Buffer.from(frame.audio_base_64, "base64"));
          observation.firstAudio.resolve();
        }
      });
    });
    const origin = `http://127.0.0.1:${reserved.claim.port}`;
    const { gateway } = await proof.start({
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      mutateConfig: (cfg) => ({
        ...cfg,
        plugins: {
          ...cfg.plugins,
          allow: [...(cfg.plugins?.allow ?? []), "elevenlabs", pluginId],
          load: { ...cfg.plugins?.load, paths: [...(cfg.plugins?.load?.paths ?? []), directory] },
          entries: {
            ...cfg.plugins?.entries,
            elevenlabs: { enabled: true },
            [pluginId]: { enabled: true },
          },
        },
        models: {
          ...cfg.models,
          providers: {
            ...cfg.models?.providers,
            elevenlabs: { baseUrl: origin, apiKey: "synthetic-proof-key", models: [] },
          },
        },
        tools: {
          ...cfg.tools,
          media: {
            ...cfg.tools?.media,
            models: [
              { provider: "elevenlabs", model: "scribe_v2_realtime", capabilities: ["audio"] },
            ],
            audio: { enabled: true },
          },
        },
      }),
    });
    proof.track(async () => {
      complete.gate?.end();
      canceled.gate?.end();
    });

    const pending = gateway.call("finite-proof.transcribe", {}, { timeoutMs: 60_000 });
    await Promise.race([
      Promise.all([complete.firstAudio.promise, complete.gateArrived.promise]),
      pending.then(() => {
        throw new Error("Gateway transcription settled before progressive upload");
      }),
    ]);
    expect(Buffer.concat(complete.frames)).toHaveLength(32000);
    expect(complete.commits).toEqual([]);
    complete.gate?.end();
    const result = await pending;
    expect(result).toEqual({
      result: {
        supported: true,
        text: "First segment. Final starlight.",
        no_speech: false,
        mode: "realtime",
        provider: "elevenlabs",
        model: "scribe_v2_realtime",
      },
      inputEnded: true,
      gatewayPid: expect.any(Number),
    });
    expect(result).not.toMatchObject({ gatewayPid: process.pid });
    await complete.closed.promise;
    expect(Buffer.concat(complete.frames)).toHaveLength(288000);
    expect(complete.commits).toEqual([256000, 288000]);

    current = canceled;
    const cancelPending = gateway.call("finite-proof.transcribe", {}, { timeoutMs: 60_000 });
    await Promise.race([
      Promise.all([canceled.firstAudio.promise, canceled.gateArrived.promise]),
      cancelPending.then(() => {
        throw new Error("Gateway transcription settled before cancellation");
      }),
    ]);
    expect(await gateway.call("finite-proof.cancel", {})).toEqual({ canceled: true });
    expect(await cancelPending).toEqual({ canceled: true, inputEnded: false });
    await canceled.closed.promise;
    expect(Buffer.concat(canceled.frames)).toHaveLength(32000);
    expect(canceled.commits).toEqual([]);
    expect(connections).toBe(2);
    expect(unexpectedHttp).toBe(0);
    writeSync(
      1,
      "FINITE_STT_GATEWAY_PROOF " +
        JSON.stringify({
          entry:
            "Gateway RPC -> loaded consumer -> typed host runtime -> bundled ElevenLabs -> WebSocket",
          complete: {
            bytes: Buffer.concat(complete.frames).length,
            commits: complete.commits,
            result,
          },
          cancellation: { bytes: Buffer.concat(canceled.frames).length, commits: canceled.commits },
          connections,
          unexpectedHttp,
        }) +
        "\n",
    );
  },
);
