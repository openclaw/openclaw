import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createQaGatewayChild, TINY_PNG_BASE64 } from "../../../../extensions/qa-lab/api.js";
import {
  writeOpenAiResponsesItem,
  readLatestUserMarker,
} from "../../../helpers/openai-responses-item.test-support.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// Only external inference and image bytes are scripted. The real Codex app-server
// creates the child, routes its dynamic calls, and returns results to its model.
it(
  "returns granted memory and a generated image artifact directly to a native Codex child",
  { timeout: 180_000 },
  async () => {
    const secret = randomUUID();
    const parentMarker = "START_NATIVE_GRANT_PROBE";
    const childMarker = "READ_NATIVE_GRANT_PROBE";
    let memoryOutput: unknown;
    let imageOutput: unknown;
    const imageRequests: unknown[] = [];
    const parentOutputs: unknown[] = [];
    const missing: string[] = [];
    let spawned = false;
    const server = createServer((req, res) => {
      void (async () => {
        if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              object: "list",
              data: [{ id: "gpt-5.6-luna", object: "model" }],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/images/generations") {
          imageRequests.push(await json(req));
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ data: [{ b64_json: TINY_PNG_BASE64 }] }));
          return;
        }
        if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
          res.writeHead(404).end();
          return;
        }
        const body: unknown = await json(req);
        if (!isRecord(body) || !Array.isArray(body.input)) {
          res.writeHead(400).end();
          return;
        }
        // A fork can inherit the parent's user message. Identify the child
        // from Codex's request source, not by searching the inherited prompt.
        const child = req.headers["x-openai-subagent"] === "collab_spawn";
        const scenario = child ? "child" : readLatestUserMarker(body, [["parent", parentMarker]]);
        let parentOutput = false;
        for (const entry of body.input) {
          if (!isRecord(entry) || entry.type !== "function_call_output") {
            continue;
          }
          if (child && entry.call_id === "call_memory_get") {
            memoryOutput = entry.output;
          }
          if (child && entry.call_id === "call_image_generate") {
            imageOutput = entry.output;
          }
          if (!child && entry.call_id === "call_spawn_agent") {
            parentOutputs.push(entry.output);
            parentOutput = true;
          }
        }
        // Choose exactly the advertised wire identity. Direct loading may expose the
        // function at the root, while native collaboration versions may namespace it.
        const toolName = !child ? "spawn_agent" : memoryOutput ? "image_generate" : "memory_get";
        const output = child ? imageOutput : parentOutput;
        const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
        const rootTool = tools.find((tool) => tool.name === toolName);
        const group = tools.find(
          (tool) =>
            tool.type === "namespace" &&
            Array.isArray(tool.tools) &&
            tool.tools.some((nested) => isRecord(nested) && nested.name === toolName),
        );
        const tool =
          rootTool ??
          (Array.isArray(group?.tools)
            ? group.tools.find((nested) => isRecord(nested) && nested.name === toolName)
            : undefined);
        if (scenario && !output && !tool) {
          missing.push(
            `${scenario} did not advertise ${toolName}; available: ${tools.map((t) => t.name).join(", ")}`,
          );
        }
        const item =
          output || !scenario || !tool || (!child && spawned)
            ? {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Finished." }],
              }
            : {
                type: "function_call",
                call_id: `call_${toolName}`,
                ...(group && !rootTool ? { namespace: group.name } : {}),
                name: toolName,
                arguments: JSON.stringify(
                  toolName === "image_generate"
                    ? { prompt: "A QA lighthouse." }
                    : child
                      ? { path: "memory/probe.md" }
                      : {
                          ...(isRecord(tool.parameters) &&
                          isRecord(tool.parameters.properties) &&
                          tool.parameters.properties.task_name
                            ? { task_name: "reader" }
                            : {}),
                          message: childMarker,
                        },
                ),
              };
        if (!child && item.type === "function_call") {
          spawned = true;
        }
        writeOpenAiResponsesItem(res, `resp_${randomUUID()}`, item, {
          input_tokens: 32,
          input_tokens_details: null,
          output_tokens: 16,
          output_tokens_details: null,
          total_tokens: 48,
        });
      })().catch(() => res.writeHead(500).end());
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("No mock provider port");
    }
    const providerBaseUrl = `http://127.0.0.1:${address.port}/v1`;
    const owner = createQaGatewayChild();
    await runQaGatewayFixture(
      async () => {
        const gateway = await owner.start({
          repoRoot: process.cwd(),
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          transportBaseUrl: "http://127.0.0.1",
          providerMode: "mock-openai",
          providerBaseUrl,
          forcedRuntime: "codex",
          codexMockNativeSubagents: true,
          runtimeSelection: "configured",
          primaryModel: "mock-openai/gpt-5.6-luna",
          alternateModel: "mock-openai/gpt-5.6-luna",
          enabledPluginIds: ["codex", "memory-core"],
          controlUiEnabled: false,
          mutateConfig(config) {
            // The observer is this HTTP server. Exercise the shipped plugins,
            // without requiring the private QA plugin in the packaged Gateway.
            delete config.plugins!.entries!["qa-lab"];
            config.plugins!.allow = config.plugins!.allow?.filter((id) => id !== "qa-lab");
            const codex = config.plugins!.entries!.codex!;
            codex.config = {
              ...codex.config,
              codexDynamicToolsLoading: "direct",
              nativeChildTools: { allow: ["memory_get", "image_generate"] },
            };
            // Only the image route goes to the loopback image endpoint; do not
            // override the Codex model route used to authenticate native children.
            const openai = config.models!.providers!.openai!;
            const image = "gpt-image-1";
            const imageRoute = openai.models.find((model) => model.id === image);
            if (!imageRoute) {
              throw new Error("Missing QA image model");
            }
            imageRoute.baseUrl = providerBaseUrl;
            config.agents!.defaults!.mediaModels = { image: { primary: `openai/${image}` } };
            return config;
          },
        });
        const dir = path.join(gateway.workspaceDir, "memory");
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "probe.md"), secret);
        await gateway.call("chat.send", {
          sessionKey: "agent:qa:main",
          message: parentMarker,
          deliver: false,
          idempotencyKey: randomUUID(),
        });
        await expect
          .poll(
            () => {
              if (imageOutput !== undefined || missing.length) {
                return true;
              }
              return {
                missing: missing.slice(-2),
                parentOutputs: parentOutputs.slice(-2),
                gateway: gateway.logs().slice(-2500),
              };
            },
            { timeout: 65_000 },
          )
          .toBe(true);
        const diagnostic = gateway
          .logs()
          .split("\n")
          .filter((line) =>
            /tool call|request handler|native child|native subagent|retained|assignment|source changed/i.test(
              line,
            ),
          )
          .slice(-18)
          .join("\n");
        expect(missing, diagnostic).toEqual([]);
        expect(JSON.stringify(memoryOutput), diagnostic).toContain(secret);
        const output = Array.isArray(imageOutput)
          ? imageOutput
              .filter(isRecord)
              .map((item) => item.text)
              .join("\n")
          : String(imageOutput);
        expect(output, diagnostic).toContain("Generated 1 image");
        expect(imageRequests).toEqual([expect.objectContaining({ prompt: "A QA lighthouse." })]);
        const artifact = /path="([^"]+)"/u.exec(output)?.[1];
        if (!artifact || !artifact.startsWith(gateway.tempRoot + path.sep)) {
          throw new Error("Child did not receive a file path in the isolated Gateway");
        }
        expect(await fs.readFile(artifact, "base64")).toBe(TINY_PNG_BASE64);
        const history = await gateway.call("chat.history", { sessionKey: "agent:qa:main" });
        expect(JSON.stringify(history)).not.toContain(path.basename(artifact));
      },
      () => stopQaGatewayFixture(owner),
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
  },
);
