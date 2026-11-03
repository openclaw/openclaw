import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Option } from "commander";
import { afterAll, expect, it } from "vitest";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { listBundledPluginMetadata } from "../../src/plugins/bundled-plugin-metadata.js";
import type { OpenClawPluginDefinition } from "../../src/plugins/plugin-definition.types.js";
import type { ProviderResolveNonInteractiveApiKeyParams } from "../../src/plugins/types.js";
import { createNonExitingRuntime } from "../../src/runtime.js";
import { createCapturedPluginRegistration } from "../../src/test-utils/plugin-registration.js";

const PARITY_SHARD_COUNT = 3;
const SENTINEL_API_KEY = "parity-sentinel-api-key";
// Manifest-derived factories and Copilot's full token setup have their own owner proof.
const OWNER_TESTED_PLUGIN_IDS = new Set(
  `abliteration baseten byteplus cerebras clawrouter cohere deepseek featherless fireworks gmi groq
  huggingface kilocode kimi longcat meta mistral novita nvidia opencode opencode-go
  openrouter qianfan radius requesty synthetic together venice vercel-ai-gateway volcengine github-copilot`.split(
    /\s+/,
  ),
);
// Regional factories return before configuration in the null-key probe.
const SHARED_LITERAL_FACTORIES = new Set(["minimax", "stepfun", "xiaomi", "zai"]);

const allParityCases = listBundledPluginMetadata({ includeChannelConfigs: false }).flatMap(
  ({ manifest }) =>
    (manifest.providerAuthChoices ?? []).flatMap((choice) => {
      if (!choice.optionKey?.trim() || !choice.cliFlag?.trim()) {
        return [];
      }
      if (choice.cliOption) {
        const option = new Option(choice.cliOption);
        // Boolean setup flags have no API-key literal to probe.
        if (!option.required && !option.optional) {
          return [];
        }
      }
      return {
        pluginId: manifest.id,
        providerId: choice.provider,
        methodId: choice.method,
        optionKey: choice.optionKey,
        cliFlag: choice.cliFlag,
        setupEnvVars:
          manifest.setup?.providers?.findLast((entry) => entry.id === choice.provider)?.envVars ??
          [],
      };
    }),
);
type ParityCase = (typeof allParityCases)[number];

export function defineBundledProviderAuthLiteralParityTests(shardIndex: number): void {
  const parityPluginIds = [...new Set(allParityCases.map((entry) => entry.pluginId))]
    .toSorted((left, right) => left.localeCompare(right))
    .filter(
      (pluginId, index) =>
        index % PARITY_SHARD_COUNT === shardIndex && !OWNER_TESTED_PLUGIN_IDS.has(pluginId),
    );
  const parityPluginIdSet = new Set(parityPluginIds);
  const probeGroups = new Map<string, { parityCase: ParityCase; methodIds: string[] }>();
  for (const entry of allParityCases
    .filter((candidate) => parityPluginIdSet.has(candidate.pluginId))
    .toSorted((left, right) => left.methodId.localeCompare(right.methodId))) {
    const key = JSON.stringify({
      ...entry,
      methodId: SHARED_LITERAL_FACTORIES.has(entry.pluginId) ? undefined : entry.methodId,
    });
    const group = probeGroups.get(key) ?? { parityCase: entry, methodIds: new Array<string>() };
    group.methodIds.push(entry.methodId);
    probeGroups.set(key, group);
  }
  const probeAgentDir = mkdtempSync(path.join(tmpdir(), "openclaw-auth-parity-"));
  const registrations = new Map<string, ReturnType<typeof createCapturedPluginRegistration>>();

  async function registration(pluginId: string) {
    const existing = registrations.get(pluginId);
    if (existing) {
      return existing;
    }
    // Lazy load: eager built-plugin graphs break co-resident unit-fast mocks.
    const { loadBundledPluginFacade } =
      await import("../../src/test-utils/bundled-plugin-public-surface.js");
    const mod = await loadBundledPluginFacade<
      OpenClawPluginDefinition & { default?: OpenClawPluginDefinition }
    >({
      pluginId,
      artifactBasename: "index.js",
    });
    const register = mod.default?.register ?? mod.register;
    assert(register, `bundled plugin ${pluginId} has no register() entry`);
    const captured = createCapturedPluginRegistration({
      id: pluginId,
      name: pluginId,
      source: `bundled:${pluginId}`,
    });
    captured.api.runtime = createPluginRuntimeMock();
    register(captured.api);
    registrations.set(pluginId, captured);
    return captured;
  }

  afterAll(() => rmSync(probeAgentDir, { recursive: true, force: true }));

  it.each([...probeGroups.values()])(
    "auth literal parity: $parityCase.pluginId $parityCase.providerId/$parityCase.methodId optionKey=$parityCase.optionKey",
    { timeout: 120_000 },
    async ({ parityCase, methodIds }) => {
      const { pluginId, providerId, methodId, optionKey, cliFlag, setupEnvVars } = parityCase;
      const captured = await registration(pluginId);
      const provider = captured.providers.find(
        (entry) => entry.id === providerId || entry.hookAliases?.includes(providerId),
      );
      if (!provider) {
        // Capability-only plugins may omit text providers, never declare different ones.
        expect(
          captured.providers,
          `${pluginId} manifest declares ${providerId} but runtime registers different providers`,
        ).toEqual([]);
        return;
      }

      expect(provider.auth.map((entry) => entry.id)).toEqual(expect.arrayContaining(methodIds));
      const method = provider.auth.find((entry) => entry.id === methodId);
      assert(method, `${pluginId} runtime auth missing method ${methodId}`);

      let probed: ProviderResolveNonInteractiveApiKeyParams | undefined;
      try {
        await method.runNonInteractive?.({
          authChoice: "parity",
          agentDir: probeAgentDir,
          config: {},
          baseConfig: {},
          // Only the expected key gets the sentinel; preflight options get distinct placeholders.
          opts: new Proxy<Record<string, unknown>>(
            { [optionKey]: SENTINEL_API_KEY },
            {
              get: (target, key) =>
                typeof key === "string" ? (target[key] ?? `parity-extra-${key}`) : undefined,
            },
          ),
          runtime: createNonExitingRuntime(),
          resolveApiKey: async (params) => {
            probed ??= params;
            return null;
          },
          toApiKeyCredential: () => null,
        });
      } catch {
        // Some methods throw when credentials are incomplete; captured params still count.
      }
      assert(probed, `${pluginId}/${methodId} did not resolve an API key non-interactively`);

      expect(probed).toMatchObject({ flagName: cliFlag, flagValue: SENTINEL_API_KEY });

      const knownEnvVars = new Set([...setupEnvVars, ...(provider.envVars ?? [])]);
      if (knownEnvVars.size > 0) {
        expect(knownEnvVars.has(probed.envVar)).toBe(true);
      }
    },
  );
}
