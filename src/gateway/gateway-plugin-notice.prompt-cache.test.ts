import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  assertStableProviderPrefix,
  snapshotProviderPrefix,
} from "../../scripts/e2e/lib/anthropic-cache/prefix-stability.mts";
import * as nativeModule from "../plugins/native-module-require.js";
import { createHostChannelInboundRuntime, createPluginRuntime } from "../plugins/runtime/index.js";
import * as sdkAlias from "../plugins/sdk-alias.js";
import { createChatFixture, sendChatAndWait } from "./gateway-chat-fixture.test-support.js";

const PLUGIN_ID = "notice-cache-proof";
const NOTICE_TEXT = "NOTICE_ROW_TEXT_7f3a";
const SYSTEM_EVENT_TEXT = "SYSTEM_EVENT_TEXT_7f3a";
// A real on-disk plugin: its Gateway method posts a transcript-only notice with a system event.
const PLUGIN_SOURCE = `module.exports = { id: "${PLUGIN_ID}", register(api) {
  api.registerGatewayMethod("noticeproof.post", async ({ params, respond }) => {
    try {
      const generation = await api.runtime.system.captureSessionGeneration({
        agentId: "main",
        sessionKey: params.sessionKey,
      });
      const result = await api.runtime.system.postSessionNotice({
        generation,
        notice: { type: "done", text: "${NOTICE_TEXT}", data: { job: 1 } },
        idempotencyKey: "${PLUGIN_ID}:1",
        systemEvent: "${SYSTEM_EVENT_TEXT}",
      });
      respond(true, result);
    } catch (error) {
      respond(true, { error: String(error) });
    }
  }, { scope: "operator.write" });
} };`;

const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-notice-cache-plugin-"));
fs.writeFileSync(path.join(pluginDir, "index.cjs"), PLUGIN_SOURCE);
fs.writeFileSync(
  path.join(pluginDir, "package.json"),
  JSON.stringify({ name: PLUGIN_ID, version: "1.0.0", openclaw: { extensions: ["./index.cjs"] } }),
);
fs.writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: PLUGIN_ID,
    activation: { onStartup: true },
    configSchema: { type: "object" },
  }),
);

const fixture = createChatFixture("plugin-notice-cache", {
  configure(config, model) {
    const modelRef = `openai/${model.modelId}`;
    model.config.models[0].compat = {
      supportsPromptCacheKey: true,
      supportsStore: false,
      sendSessionIdHeader: true,
    };
    return {
      ...config,
      agents: {
        defaults: {
          ...config.agents?.defaults,
          utilityModel: "",
          model: { primary: modelRef },
          models: { [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
      },
      models: { mode: "replace", providers: { openai: model.config } },
      tools: { toolSearch: false },
      plugins: {
        allow: ["openai", PLUGIN_ID],
        load: { paths: [path.resolve("extensions/openai"), pluginDir] },
        slots: { memory: "none" },
      },
    };
  },
});

beforeAll(async () => {
  // Production loads the host runtime natively into the Gateway's module graph. Under Vitest a
  // native require would load a second copy with its own config snapshot, so hand the loader
  // this graph's real runtime factory instead.
  const resolveRuntime = vi.spyOn(sdkAlias, "resolvePluginRuntimeModulePathWithDiagnostics");
  const nativeLoad = nativeModule.tryNativeRequireModule;
  vi.spyOn(nativeModule, "tryNativeRequireModule").mockImplementation((modulePath, options) =>
    modulePath === resolveRuntime.mock.results.at(-1)?.value?.resolvedPath
      ? { ok: true, moduleExport: { createPluginRuntime, createHostChannelInboundRuntime } }
      : nativeLoad(modulePath, options),
  );
  await fixture.start();
}, 90_000);

afterAll(async () => {
  await fixture.close();
  vi.restoreAllMocks();
  fs.rmSync(pluginDir, { recursive: true, force: true });
});

it("keeps the foreground prompt prefix when a plugin posts a transcript-only notice", async () => {
  const sessionKey = `agent:main:notice-cache-${randomUUID()}`;
  const start = fixture.requests.length;
  await sendChatAndWait(fixture.client, sessionKey, "Turn N: remember the plan.", 60_000);

  const posted = await fixture.client.request("noticeproof.post", { sessionKey });
  expect(posted).toEqual({ status: "posted", delivered: false });
  const history = await fixture.client.request<{
    messages: Array<{ openclawDeliveryMirror?: unknown }>;
  }>("chat.history", { sessionKey, limit: 20 });
  expect(history.messages.map((message) => message.openclawDeliveryMirror)).toContainEqual({
    kind: "plugin-notice",
    pluginId: PLUGIN_ID,
    type: "done",
    data: { job: 1 },
  });

  await sendChatAndWait(fixture.client, sessionKey, "Turn N+1: continue.", 60_000);
  expect(fixture.errors).toEqual([]);
  const turns = fixture.requests.slice(start);
  expect(turns).toHaveLength(2);
  const [before, after] = turns.map((body) => JSON.parse(body) as Record<string, unknown>);
  const previous = snapshotProviderPrefix("openai-responses", before);
  const next = snapshotProviderPrefix("openai-responses", after);
  // System prompt, tools, cache key and every history item of turn N stay byte-identical.
  assertStableProviderPrefix(previous, next, { label: "plugin notice between turns" });
  expect(after!.prompt_cache_key).toBe(before!.prompt_cache_key);
  expect(next.history.length).toBeGreaterThan(previous.history.length);
  const appended = next.history.slice(previous.history.length).join("\n");
  // The queued system event reaches only the next turn's appended input.
  expect(previous.history.join("\n")).not.toContain(SYSTEM_EVENT_TEXT);
  expect(appended).toContain(SYSTEM_EVENT_TEXT);
  // The transcript-only notice row never enters model context (#189964 contract).
  expect(JSON.stringify(after)).not.toContain(NOTICE_TEXT);
}, 180_000);
