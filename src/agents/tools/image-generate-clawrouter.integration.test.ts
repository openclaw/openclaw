import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { acquireTestPortBlock, useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBundledProviderPlugin } from "../../../test/helpers/media-generation/bundled-provider-builders.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveMediaBuffer } from "../../media/store.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPreparedModelRuntimeFixture } from "../embedded-agent-runner/model.fixture.test-support.js";
import { createImageGenerateTool } from "./image-generate-tool.js";

const MODEL = "google/gemini-3.1-flash-image";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
  "base64",
);
// ClawRouter 17cb1a0: google-gemini.provider.yaml and native-google-images.ts.
const catalog = {
  version: "clawrouter.client-catalog.v1",
  providers: [
    {
      id: "google-gemini",
      allowed: true,
      executable: true,
      nativeBaseUrl: "/v1/native/google-gemini",
      routes: [
        {
          endpoint: "image_generate",
          methods: ["POST"],
          path: "/v1beta/models/${model}:generateContent",
          requestFormat: "google.image_generate",
          responseFormat: "google.image",
        },
      ],
      models: [{ id: MODEL, upstream: "gemini-3.1-flash-image", capabilities: ["image.generate"] }],
      offers: [
        {
          endpoint: "image_generate",
          modelId: MODEL,
          transport: "http",
          routeKind: "native",
          route: "/v1/native/google-gemini/v1beta/models/${model}:generateContent",
          eligible: true,
          affordability: "request-dependent",
        },
      ],
    },
  ],
};

describe("image_generate uploaded ClawRouter references", () => {
  useIsolatedStateGuard();
  const calls: Array<{ url: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const server = createServer((req, res) => {
    void (async () => {
      const bytes = await buffer(req);
      calls.push({
        url: req.url ?? "",
        headers: req.headers,
        body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
      });
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify(
          req.url === "/v1/catalog"
            ? catalog
            : {
                candidates: [
                  {
                    finishReason: "STOP",
                    content: {
                      parts: [
                        {
                          inlineData: { mimeType: "image/png", data: PNG.toString("base64") },
                        },
                      ],
                    },
                  },
                ],
              },
        ),
      );
    })().catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
  });
  let baseUrl: string;
  let releasePort: () => Promise<void>;
  let captured: ReturnType<typeof createCapturedPluginRegistration>;
  beforeAll(async () => {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    releasePort = claim.release;
    server.listen(claim.port, "127.0.0.1");
    await once(server, "listening");
    baseUrl = "http://127.0.0.1:" + claim.port;
    captured = createCapturedPluginRegistration();
    (await loadBundledProviderPlugin("clawrouter")).register(captured.api);
  });
  afterAll(async () => {
    const closed = server[Symbol.asyncDispose]();
    server.closeAllConnections();
    await closed;
    await releasePort();
  });

  it("loads an uploaded PNG and delivers native inline-reference output without another paid request", async () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          clawrouter: {
            api: "openai-responses",
            baseUrl,
            apiKey: "synthetic-router-key",
            models: [],
          },
        },
      },
      agents: { defaults: { mediaModels: { image: { primary: "clawrouter/" + MODEL } } } },
    };
    const agentDir = path.join(process.env.OPENCLAW_TEST_HOME!, "agent");
    const prepared = createEmptyPreparedModelRuntimeFixture({
      config,
      agentDir,
      metadataSnapshot: createPluginMetadataSnapshotFixture(),
      createStores: () => {
        throw new Error("Image tool must not open model stores");
      },
    });
    const tool = createImageGenerateTool({
      config,
      agentDir,
      preparedModelRuntime: {
        ...prepared,
        mediaCapabilityProviders: {
          mediaUnderstandingProviders: [],
          imageGenerationProviders: captured.imageGenerationProviders,
          videoGenerationProviders: [],
          musicGenerationProviders: [],
        },
      },
    });
    expect(tool).not.toBeNull();
    const upload = await saveMediaBuffer(PNG, "image/png", "inbound", PNG.length, "room.png");
    const result = await tool!.execute("edit-upload", {
      image: upload.path,
      prompt: "Remove the person and reconstruct the room",
    });
    expect(calls.map((call) => [call.url, call.headers.authorization])).toEqual([
      ["/v1/catalog", "Bearer synthetic-router-key"],
      [
        "/v1/native/google-gemini/v1beta/models/gemini-3.1-flash-image:generateContent",
        "Bearer synthetic-router-key",
      ],
    ]);
    expect(calls[1]?.body).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "image/png", data: PNG.toString("base64") } },
            { text: "Remove the person and reconstruct the room" },
          ],
        },
      ],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    });
    const details = result.details as { paths: string[] };
    expect(details.paths).toHaveLength(1);
    expect(await fs.readFile(details.paths[0]!)).toEqual(PNG);
  });
});
