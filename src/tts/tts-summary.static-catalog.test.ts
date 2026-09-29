import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeText } from "../plugin-sdk/speech-core.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveTtsConfig } from "./tts-settings.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
});

it.each([
  { name: "canonical default", model: "kimi-for-coding" },
  { name: "canonical K3 default", model: "k3" },
  { name: "explicit summary override", model: "k3", override: true },
  {
    name: "disabled plugin",
    model: "k3",
    plugins: { entries: { kimi: { enabled: false } } },
    rejected: true,
  },
  { name: "disabled plugins", model: "k3", plugins: { enabled: false }, rejected: true },
  { name: "denied plugin", model: "k3", plugins: { deny: ["kimi"] }, rejected: true },
  { name: "omitted allowlist owner", model: "k3", plugins: { allow: ["google"] }, rejected: true },
  { name: "unknown model", model: "not-a-real-kimi-model", rejected: true },
] satisfies Array<{
  name: string;
  model: string;
  override?: boolean;
  plugins?: OpenClawConfig["plugins"];
  rejected?: boolean;
}>)(
  "respects the cold summary catalog for $name",
  async ({ model: expectedModel, override, plugins, rejected }) => {
    await withOpenClawTestState(
      {
        label: "tts-cold-static-catalog",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          KIMI_API_KEY: undefined,
          KIMICODE_API_KEY: undefined,
        },
      },
      async (state) => {
        const requests: string[] = [];
        const server = createServer((request, response) => {
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk: string) => {
            body += chunk;
          });
          request.on("end", () => {
            const { model } = JSON.parse(body) as { model: string };
            requests.push(model);
            response.writeHead(200, { "content-type": "text/event-stream" });
            const events = [
              {
                type: "message_start",
                message: {
                  id: "kimi-summary",
                  type: "message",
                  role: "assistant",
                  model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: `Summary from ${model}.` },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 6 },
              },
              { type: "message_stop" },
            ];
            response.end(
              events
                .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
                .join(""),
            );
          });
        });
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        try {
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Kimi summary fixture did not expose a TCP port");
          }
          const nativeFetch = globalThis.fetch;
          vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const request = new Request(input, init);
            expect(request.url).toBe("https://api.kimi.com/coding/v1/messages");
            return nativeFetch(`http://127.0.0.1:${address.port}/v1/messages`, {
              method: request.method,
              headers: request.headers,
              body: await request.arrayBuffer(),
              signal: request.signal,
            });
          });
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: `kimi/${override ? "kimi-for-coding" : expectedModel}`,
              },
              entries: { main: {} },
            },
            plugins: {
              allow: ["kimi"],
              entries: { kimi: { enabled: true } },
              slots: { memory: "none" },
              ...plugins,
            },
            ...(override ? { tts: { summaryModel: `kimi/${expectedModel}` } } : {}),
          };
          await state.writeConfig(cfg);
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "kimi:summary-test": { type: "api_key", provider: "kimi", key: "synthetic-kimi-key" },
            },
          });

          // No configured base URL: a generic fallback cannot hide a missing catalog alias.
          const pending = summarizeText({
            cfg,
            config: resolveTtsConfig(cfg),
            text: "Synthetic text for an ordinary TTS summary.",
            targetLength: 100,
            timeoutMs: 10_000,
          });
          if (rejected) {
            await expect(pending).rejects.toThrow(`Unknown model: kimi/${expectedModel}`);
            expect(requests).toEqual([]);
            return;
          }
          expect((await pending).summary).toBe(`Summary from ${expectedModel}.`);
          expect(requests).toEqual([expectedModel]);
          expect(resolveDefaultModelForAgent({ cfg, allowPluginNormalization: false })).toEqual({
            provider: "kimi",
            model: override ? "kimi-for-coding" : expectedModel,
          });
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
    );
  },
);
