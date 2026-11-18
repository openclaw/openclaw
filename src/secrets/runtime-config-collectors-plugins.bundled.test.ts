/** Tests bundled plugin config secret collectors. */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginOrigin } from "../plugins/types.js";
import { resolveSecretRefValues } from "./resolve.js";
import { collectPluginConfigAssignments } from "./runtime-config-collectors-plugins.js";
import { applyResolvedAssignments, createResolverContext } from "./runtime-shared.js";

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

const isolatedEnv: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_TEST_HOME };

function pluginConfig(id: string, config: Record<string, unknown>): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    plugins: { entries: { [id]: { enabled: true, config } } },
  };
}

function collect(
  config: OpenClawConfig,
  id: string,
  env = isolatedEnv,
  sourceConfig = config,
  origin: PluginOrigin = "bundled",
) {
  const context = createResolverContext({ sourceConfig, env });
  collectPluginConfigAssignments({
    config,
    defaults: undefined,
    context,
    loadablePluginOrigins: new Map([[id, origin]]),
  });
  return context;
}

async function resolveAssignments(context: ReturnType<typeof collect>, config: OpenClawConfig) {
  const resolved = await resolveSecretRefValues(
    context.assignments.map((assignment) => assignment.ref),
    { config, env: context.env, cache: context.cache },
  );
  applyResolvedAssignments({ assignments: context.assignments, resolved });
}

function expectCollected(context: ReturnType<typeof collect>, paths: string[]) {
  expect(context.assignments.map((assignment) => assignment.path).toSorted()).toEqual(paths);
  expect(context.warnings).toEqual([]);
}

describe("collectPluginConfigAssignments bundled plugin manifests", () => {
  it("resolves only explicitly referenced Google web-search headers", async () => {
    const config = pluginConfig("google", {
      webSearch: {
        headers: {
          "X-Routing-Target": "staging",
          "X-Gateway-Token": envRef("GEMINI_GATEWAY_TOKEN"),
        },
      },
    });
    const context = collect(config, "google", {
      ...isolatedEnv,
      GEMINI_GATEWAY_TOKEN: "resolved-gateway-token",
    });
    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "plugins.entries.google.config.webSearch.headers.X-Gateway-Token",
    ]);
    await resolveAssignments(context, config);
    expect(config.plugins?.entries?.google?.config).toMatchObject({
      webSearch: {
        headers: { "X-Routing-Target": "staging", "X-Gateway-Token": "resolved-gateway-token" },
      },
    });
  });

  it("materializes Tavily tool credentials from the plugin secret contract", async () => {
    const sourceConfig = pluginConfig("tavily", {
      webSearch: { apiKey: envRef("TAVILY_API_KEY") },
    });
    const runtimeConfig = structuredClone(sourceConfig);
    const context = collect(
      runtimeConfig,
      "tavily",
      { ...isolatedEnv, TAVILY_API_KEY: "resolved-tavily-key" },
      sourceConfig,
    );
    expect(context.assignments.map((assignment) => assignment.path)).toEqual([
      "plugins.entries.tavily.config.webSearch.apiKey",
    ]);
    expect(context.assignments).toMatchObject([
      {
        ownerKind: "capability",
        ownerId: "plugins.entries.tavily.config.webSearch.apiKey",
        requiredForGateway: false,
        disposition: "isolate",
      },
    ]);
    expect(context.assignments[0]?.ownerContractDigest).toBeUndefined();
    await resolveAssignments(context, sourceConfig);
    expect(sourceConfig.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: { apiKey: envRef("TAVILY_API_KEY") },
    });
    expect(runtimeConfig.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: { apiKey: "resolved-tavily-key" },
    });
  });

  it("collects voice-call SecretRef assignments from bundled manifest contracts", () => {
    const numberRouteRefs = [
      envRef("VOICE_CALL_ROUTE_ENV_KEY"),
      { source: "file" as const, provider: "route-file", id: "/voice-call/apiKey" },
      { source: "exec" as const, provider: "route-exec", id: "voice-call/apiKey" },
      { source: "store" as const, provider: "default", id: "VOICE_CALL_ROUTE_STORE_KEY" },
    ];
    const numberRoutes = Object.fromEntries(
      numberRouteRefs.map((ref, index) => [
        `+1555000100${index}`,
        { tts: { providers: { openai: { apiKey: ref } } } },
      ]),
    );
    const config = pluginConfig("voice-call", {
      numbers: numberRoutes,
      twilio: { authToken: envRef("TWILIO_AUTH_TOKEN") },
      realtime: { providers: { google: { apiKey: envRef("GEMINI_API_KEY") } } },
      streaming: { providers: { openai: { apiKey: envRef("OPENAI_API_KEY") } } },
      tts: {
        providers: {
          openai: { apiKey: envRef("OPENAI_API_KEY") },
          elevenlabs: { apiKey: envRef("ELEVENLABS_API_KEY") },
        },
      },
    });
    const context = collect(config, "voice-call");
    expectCollected(context, [
      ...numberRouteRefs.map(
        (_, index) =>
          `plugins.entries.voice-call.config.numbers["+1555000100${index}"].tts.providers.openai.apiKey`,
      ),
      "plugins.entries.voice-call.config.realtime.providers.google.apiKey",
      "plugins.entries.voice-call.config.streaming.providers.openai.apiKey",
      "plugins.entries.voice-call.config.tts.providers.elevenlabs.apiKey",
      "plugins.entries.voice-call.config.tts.providers.openai.apiKey",
      "plugins.entries.voice-call.config.twilio.authToken",
    ]);
    for (const [index, ref] of numberRouteRefs.entries()) {
      const number = `+1555000100${index}`;
      context.assignments
        .find(
          (assignment) =>
            assignment.path ===
            `plugins.entries.voice-call.config.numbers["${number}"].tts.providers.openai.apiKey`,
        )
        ?.apply(`resolved-${ref.source}`);
      expect(numberRoutes[number]?.tts.providers.openai.apiKey).toBe(`resolved-${ref.source}`);
    }
  });

  it("collects google-meet realtime provider SecretRefs from its installed manifest", () => {
    const config = pluginConfig("google-meet", {
      realtime: {
        providers: {
          google: { apiKey: envRef("GEMINI_API_KEY") },
          openai: { apiKey: envRef("OPENAI_API_KEY") },
        },
      },
    });
    config.plugins!.load = {
      paths: [fileURLToPath(new URL("../../extensions/google-meet", import.meta.url))],
    };
    expectCollected(collect(config, "google-meet", isolatedEnv, config, "config"), [
      "plugins.entries.google-meet.config.realtime.providers.google.apiKey",
      "plugins.entries.google-meet.config.realtime.providers.openai.apiKey",
    ]);
  });
});
