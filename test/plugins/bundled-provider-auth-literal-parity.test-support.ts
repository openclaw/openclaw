// Keeps manifest providerAuthChoices literals aligned with registered provider.auth methods.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPluginRuntimeMock } from "../../src/plugin-sdk/plugin-test-runtime.js";
import { listBundledPluginMetadata } from "../../src/plugins/bundled-plugin-metadata.js";
import type {
  ProviderAuthMethod,
  ProviderResolveNonInteractiveApiKeyParams,
} from "../../src/plugins/types.js";
import { createNonExitingRuntime } from "../../src/runtime.js";
import { createCapturedPluginRegistration } from "../../src/test-utils/plugin-registration.js";

const PARITY_TIMEOUT_MS = 120_000;
const PARITY_SHARD_COUNT = 3;
const SENTINEL_API_KEY = "parity-sentinel-api-key";
// These entries pass their manifest directly to defineSingleProviderPluginEntry,
// so provider-entry and provider-api-key-auth owner tests already prove the
// same literal projection. Runtime probes remain for custom/explicit auth.
const MANIFEST_DERIVED_PLUGIN_IDS = new Set([
  "baseten",
  "byteplus",
  "cerebras",
  "clawrouter",
  "cohere",
  "deepseek",
  "featherless",
  "fireworks",
  "gmi",
  "groq",
  "huggingface",
  "kilocode",
  "kimi",
  "longcat",
  "meta",
  "mistral",
  "novita",
  "nvidia",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "radius",
  "synthetic",
  "together",
  "venice",
  "vercel-ai-gateway",
  "volcengine",
]);
// GitHub Copilot's owner test derives these literals from its manifest and
// exercises the full token setup result in the already-loaded plugin suite.
const OWNER_TESTED_PLUGIN_IDS = new Set(["github-copilot"]);
// These factories share credential literals across regions; the null-key probe
// returns before regional configuration. Distinct literal tuples still get probes.
const SHARED_LITERAL_FACTORIES = new Set(["minimax", "stepfun", "xiaomi", "zai"]);

type ParityCase = {
  pluginId: string;
  providerId: string;
  methodId: string;
  optionKey: string;
  cliFlag: string;
  setupEnvVars: readonly string[];
};

type PluginRegister = (api: ReturnType<typeof createCapturedPluginRegistration>["api"]) => void;
type CapturedPluginRegistration = ReturnType<typeof createCapturedPluginRegistration>;

type PluginEntryModule = {
  default?: {
    register?: PluginRegister;
  };
  register?: PluginRegister;
};

function listParityCases(): ParityCase[] {
  return listBundledPluginMetadata({ includeChannelConfigs: false }).flatMap(({ manifest }) =>
    (manifest.providerAuthChoices ?? []).flatMap((choice) => {
      if (!choice.optionKey?.trim() || !choice.cliFlag?.trim()) {
        return [];
      }
      return [
        {
          pluginId: manifest.id,
          providerId: choice.provider,
          methodId: choice.method,
          optionKey: choice.optionKey,
          cliFlag: choice.cliFlag,
          setupEnvVars:
            manifest.setup?.providers?.findLast((entry) => entry.id === choice.provider)?.envVars ??
            [],
        },
      ];
    }),
  );
}

async function loadPluginRegister(pluginId: string): Promise<PluginRegister> {
  // Dynamic import keeps this file out of the unit-fast lane: loading built
  // plugin dists pulls large module graphs into the shared worker cache and
  // breaks co-resident vi.mock-based unit tests (observed with memory-host-sdk).
  const { loadBundledPluginFacade } =
    await import("../../src/test-utils/bundled-plugin-public-surface.js");
  const mod = await loadBundledPluginFacade<PluginEntryModule>({
    pluginId,
    artifactBasename: "index.js",
  });
  const register = mod.default?.register ?? mod.register;
  if (!register) {
    throw new Error(`bundled plugin ${pluginId} has no register() entry`);
  }
  return register;
}

async function probeRuntimeAuthLiterals(params: {
  method: ProviderAuthMethod;
  optionKey: string;
  agentDir: string;
}): Promise<ProviderResolveNonInteractiveApiKeyParams | undefined> {
  if (!params.method.runNonInteractive) {
    return undefined;
  }
  // The sentinel maps only to the expected optionKey so flagValue === sentinel
  // proves the method read the right key. Other keys get distinct placeholders
  // to satisfy provider-specific preflight opts (e.g. account/gateway ids)
  // without weakening that proof.
  const opts = new Proxy<Record<string, unknown>>(
    { [params.optionKey]: SENTINEL_API_KEY },
    {
      get: (target, key) =>
        typeof key === "string" ? (target[key] ?? `parity-extra-${key}`) : undefined,
    },
  );
  let captured: ProviderResolveNonInteractiveApiKeyParams | undefined;
  try {
    await params.method.runNonInteractive({
      authChoice: "parity",
      agentDir: params.agentDir,
      config: {},
      baseConfig: {},
      opts,
      runtime: createNonExitingRuntime(),
      resolveApiKey: async (resolveParams) => {
        if (!captured) {
          captured = resolveParams;
        }
        return null;
      },
      toApiKeyCredential: () => null,
    });
  } catch {
    // Some methods throw when credentials are incomplete; captured params still count.
  }
  return captured;
}

const allParityCases = listParityCases().toSorted(
  (left, right) =>
    left.pluginId.localeCompare(right.pluginId) ||
    left.providerId.localeCompare(right.providerId) ||
    left.methodId.localeCompare(right.methodId),
);

const allParityPluginIds = [...new Set(allParityCases.map((entry) => entry.pluginId))];
export function defineBundledProviderAuthLiteralParityTests(shardIndex: number): void {
  const parityPluginIds = allParityPluginIds.filter(
    (pluginId, index) =>
      index % PARITY_SHARD_COUNT === shardIndex &&
      !MANIFEST_DERIVED_PLUGIN_IDS.has(pluginId) &&
      !OWNER_TESTED_PLUGIN_IDS.has(pluginId),
  );
  const parityPluginIdSet = new Set(parityPluginIds);
  const parityCases = allParityCases.filter((entry) => parityPluginIdSet.has(entry.pluginId));
  const probeGroups = new Map<string, ParityCase[]>();
  for (const entry of parityCases) {
    const key = JSON.stringify({
      ...entry,
      methodId: SHARED_LITERAL_FACTORIES.has(entry.pluginId) ? undefined : entry.methodId,
    });
    probeGroups.set(key, [...(probeGroups.get(key) ?? []), entry]);
  }
  const probes = [...probeGroups.values()].map((cases) => ({
    parityCase: cases[0]!,
    methodIds: cases.map((entry) => entry.methodId),
  }));
  const probeAgentDir = mkdtempSync(path.join(tmpdir(), "openclaw-auth-parity-"));
  const registrations = new Map<string, CapturedPluginRegistration>();

  beforeAll(async () => {
    // Full plugin entry graphs contend heavily when transformed concurrently.
    for (const pluginId of parityPluginIds) {
      const register = await loadPluginRegister(pluginId);
      const captured = createCapturedPluginRegistration({
        id: pluginId,
        name: pluginId,
        source: `bundled:${pluginId}`,
      });
      captured.api.runtime = createPluginRuntimeMock();
      register(captured.api);
      registrations.set(pluginId, captured);
    }
  });

  afterAll(() => {
    rmSync(probeAgentDir, { recursive: true, force: true });
  });

  describe(`bundled provider manifest↔runtime auth literal parity (${shardIndex + 1}/${PARITY_SHARD_COUNT})`, () => {
    it("discovers custom api-key-style provider auth choices", () => {
      expect(allParityCases.length).toBeGreaterThan(parityCases.length);
      expect(parityCases.length).toBeGreaterThan(0);
    });

    it.each(probes)(
      "$parityCase.pluginId $parityCase.providerId/$parityCase.methodId optionKey=$parityCase.optionKey",
      { timeout: PARITY_TIMEOUT_MS },
      async ({ parityCase, methodIds }) => {
        const captured = registrations.get(parityCase.pluginId);
        if (!captured) {
          throw new Error(`bundled plugin ${parityCase.pluginId} was not preloaded`);
        }
        const provider = captured.providers.find(
          (entry) =>
            entry.id === parityCase.providerId ||
            entry.hookAliases?.includes(parityCase.providerId),
        );
        if (!provider) {
          // Capability-only plugins (video/image onboard flags) register no text
          // providers at all. A plugin that registers text providers but not the
          // manifest-declared id has drifted — the exact mismatch this test guards.
          expect(
            captured.providers.map((entry) => entry.id),
            `${parityCase.pluginId} manifest declares provider ${parityCase.providerId} but runtime registers different providers`,
          ).toEqual([]);
          return;
        }

        expect(provider.auth.map((entry) => entry.id)).toEqual(expect.arrayContaining(methodIds));
        const method = provider.auth.find((entry) => entry.id === parityCase.methodId);
        if (!method) {
          throw new Error(
            `${parityCase.pluginId} runtime auth missing method ${parityCase.methodId}`,
          );
        }

        const probed = await probeRuntimeAuthLiterals({
          method,
          optionKey: parityCase.optionKey,
          agentDir: probeAgentDir,
        });
        if (!probed) {
          throw new Error(
            `${parityCase.pluginId} auth method ${parityCase.methodId} did not resolve an API key non-interactively; flag/env literals unverifiable`,
          );
        }

        // cliFlag ↔ flagName; optionKey proven when opts[optionKey] becomes flagValue
        expect(probed.flagName).toBe(parityCase.cliFlag);
        expect(probed.flagValue).toBe(SENTINEL_API_KEY);

        // envVar ↔ setup.providers[].envVars and/or provider.envVars
        const knownEnvVars = new Set([...parityCase.setupEnvVars, ...(provider.envVars ?? [])]);
        if (knownEnvVars.size > 0) {
          expect(knownEnvVars.has(probed.envVar)).toBe(true);
        }
      },
    );
  });
}
