/**
 * Real behavior proof: OpenRouter music SSE malformed frame → skip, valid audio → decoded.
 *
 * Starts a local node:http server that serves an SSE stream mimicking the OpenRouter
 * chat/completions format with an injected malformed data frame followed by a valid
 * audio delta, then calls generateMusic() with baseUrl redirected to localhost.
 *
 * Usage: node --import tsx test/_proof_openrouter_music_json_guard.mts
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`PASS  ${label}${detail ? ` :: ${detail}` : ""}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` :: ${detail}` : ""}`);
    fail++;
  }
}

async function main() {
  const audioBase64 = Buffer.from("fake-audio-data").toString("base64");

  // SSE stream: malformed frame → valid audio delta → [DONE]
  const sseBody = [
    `data: NOT JSON {{{\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { audio: { data: audioBase64 } } }],
    })}\n`,
    "data: [DONE]\n",
  ].join("");

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sseBody);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const localBaseUrl = `http://127.0.0.1:${addr.port}`;

  const { buildOpenRouterMusicGenerationProvider } = await import(
    "../extensions/openrouter/music-generation-provider.js"
  );

  try {
    const provider = buildOpenRouterMusicGenerationProvider();
    const result = await provider.generateMusic({
      provider: "openrouter",
      model: "google/lyria-3-clip-preview",
      prompt: "proof: skip malformed SSE frame",
      cfg: {
        models: {
          providers: {
            openrouter: { baseUrl: localBaseUrl },
          },
        },
      },
    });

    check(
      "malformed frame skipped: produces 1 audio track",
      result.tracks.length === 1,
      `tracks=${result.tracks.length}`,
    );
    check(
      "valid audio frame decoded",
      result.tracks[0]?.buffer != null,
      `buffer_len=${result.tracks[0]?.buffer?.length ?? 0}`,
    );
  } catch (err) {
    check(
      "unexpected crash",
      false,
      `error=${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    server.close();
  }

  console.log(`\n[proof] ${pass} PASS, ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
}
main();
