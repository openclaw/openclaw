import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveMediaBuffer } from "../../media/store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { createImageGenerateTool } from "./image-generate-tool.js";

const MODEL = "openai/gpt-image-2.5-sunburst-2026-09-08";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
  "base64",
);

// Owns upload -> actual tool -> registered adapter -> HTTP -> saved output proof.
// Text-only generation and adapter rejection paths live in the provider suite.
it("edits an inbound PNG with the exact OpenAI model and router credential, then persists output", async () => {
  const inventory = {
    version: "clawrouter.client-catalog.v1",
    providers: [
      {
        id: "openai",
        allowed: true,
        executable: true,
        routes: [
          {
            endpoint: "images_edits",
            methods: ["POST"],
            path: "/v1/images/edits",
            requestFormat: "openai.images_edits",
            responseFormat: "openai.images_generations",
          },
        ],
        models: [
          {
            id: MODEL,
            capabilities: ["image.edit"],
            pricing: {
              unit: "image_token",
              generation: {
                maxPromptCharacters: 32000,
                maxImages: 10,
                dimensionMultiple: 16,
                minPixels: 655360,
                maxPixels: 8294400,
                maxEdge: 3840,
                maxAspectRatio: 3,
              },
            },
          },
        ],
        offers: [
          {
            endpoint: "images_edits",
            modelId: MODEL,
            transport: "http",
            routeKind: "unified",
            route: "/v1/images/edits",
            eligible: true,
            affordability: "request-dependent",
          },
        ],
      },
    ],
  };
  const calls: Array<{ url: string; headers: IncomingHttpHeaders; body: unknown }> = [];
  const { listener, claim, releaseListener } = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const bytes = await buffer(request);
          calls.push({
            url: request.url ?? "",
            headers: request.headers,
            body: bytes.length ? JSON.parse(bytes.toString()) : undefined,
          });
          response.setHeader("Content-Type", "application/json");
          if (request.url === "/v1/catalog") {
            response.end(JSON.stringify(inventory));
          } else if (request.url === "/v1/images/edits") {
            response.end(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }));
          } else {
            response.writeHead(404).end();
          }
        })().catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : undefined),
        );
      }),
  });
  try {
    await withOpenClawTestState({ label: "clawrouter-upload-edit" }, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "clawrouter:locked": {
            type: "api_key",
            provider: "clawrouter",
            key: "synthetic-router-key",
          },
          "openai:default": { type: "api_key", provider: "openai", key: "synthetic-upstream-key" },
        },
      });
      const baseUrl = "http://127.0.0.1:" + claim.port;
      const cfg: OpenClawConfig = {
        plugins: { allow: ["clawrouter", "openai"], entries: { clawrouter: { enabled: true } } },
        agents: { defaults: { mediaModels: { image: { primary: "clawrouter/" + MODEL } } } },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: baseUrl + "/other-provider",
              apiKey: "openai:default",
              models: [],
            },
            clawrouter: {
              api: "openai-responses",
              baseUrl,
              apiKey: "clawrouter:locked",
              models: [],
            },
          },
        },
      };
      const upload = await saveMediaBuffer(PNG, "image/png", "inbound");
      const tool = createImageGenerateTool({
        config: cfg,
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        fsPolicy: { workspaceOnly: true },
      });
      expect(tool).not.toBeNull();
      const result = await tool!.execute("uploaded-reference", {
        prompt: "Make the square blue",
        model: "clawrouter/" + MODEL,
        image: upload.path,
        size: "1024x1024",
      });
      expect(result.details).toMatchObject({ provider: "clawrouter", model: MODEL, count: 1 });
      const details = result.details as { paths: string[] };
      expect(details.paths).toHaveLength(1);
      expect(await fs.readFile(details.paths[0]!)).toEqual(PNG);
      expect(details.paths[0]).not.toBe(upload.path);
      expect(calls.map(({ url, headers }) => [url, headers.authorization])).toEqual([
        ["/v1/catalog", "Bearer synthetic-router-key"],
        ["/v1/images/edits", "Bearer synthetic-router-key"],
      ]);
      expect(calls[1]?.body).toEqual({
        model: MODEL,
        prompt: "Make the square blue",
        n: 1,
        size: "1024x1024",
        images: [{ image_url: "data:image/png;base64," + PNG.toString("base64") }],
      });
    });
  } finally {
    listener.closeAllConnections();
    await releaseListener();
    await claim.release();
  }
});
