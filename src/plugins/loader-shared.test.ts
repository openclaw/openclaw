import fs from "node:fs";
import { afterAll, expect, it } from "vitest";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginCandidateInstallOwner } from "./candidate-install-owner.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import { createPluginActivationSource } from "./config-state.js";
import type { PluginCandidate } from "./discovery.js";
import {
  createPluginCandidatesFromManifestRegistry,
  preparePluginLoadRecord,
  validatePluginConfig as validatePluginConfigByOrigin,
} from "./loader-shared.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { loadOpenClawPluginCliRegistry, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA as emptyObjectSchema,
  resetPluginLoaderTestStateForTest,
} from "./loader.test-fixtures.js";
import { recordPluginManifestInstallOwner } from "./manifest-install-owner.js";
import { waitForPluginCacheRetirement } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

function validatePluginConfig(
  params: Omit<Parameters<typeof validatePluginConfigByOrigin>[0], "origin">,
) {
  return validatePluginConfigByOrigin({ ...params, origin: "global" });
}

function withCredential(
  config: OpenClawConfig,
  id: string,
  credential: unknown,
  enabled = true,
): OpenClawConfig {
  return {
    ...config,
    plugins: { ...config.plugins, entries: { [id]: { enabled, config: { credential } } } },
  };
}

const credentialRef = (id = "KEY") => ({ source: "store", provider: "default", id });
const credentialSchema = {
  type: "object",
  required: ["source", "provider", "id"],
  properties: {
    source: { const: "store" },
    provider: { type: "string" },
    id: { type: "string" },
  },
};
const cliDescriptors = (registry: ReturnType<typeof loadOpenClawPlugins>) =>
  registry.cliRegistrars.flatMap((registrar) => registrar.descriptors);

const manifestRecord = createPluginManifestRecordFixture({
  id: "example",
  origin: "global",
  rootDir: "/plugins/example",
});

function createRecordWithBuildVersion(openclawVersion: unknown) {
  const candidate = {
    idHint: "example",
    source: manifestRecord.source,
    rootDir: manifestRecord.rootDir,
    origin: manifestRecord.origin,
    packageManifest: {
      build: { openclawVersion },
    } as unknown as NonNullable<PluginCandidate["packageManifest"]>,
  } satisfies PluginCandidate;

  const cfg = { plugins: { entries: { example: { enabled: true } } } };
  const activationSource = createPluginActivationSource({ config: cfg });
  return preparePluginLoadRecord({
    candidate,
    manifestRecord,
    context: {
      cfg,
      normalized: activationSource.plugins,
      activationSource,
      autoEnabledReasons: {},
      shouldLoadModules: true,
    },
    onlyPluginIdSet: null,
    dreamingSidecar: null,
    registry: { plugins: [] },
    seenIds: new Map(),
  })?.record;
}

it("preparePluginLoadRecord ignores malformed package build version metadata", () => {
  expect(createRecordWithBuildVersion(" 2026.7.2 ")).toHaveProperty(
    "builtWithOpenClawVersion",
    "2026.7.2",
  );
  expect(createRecordWithBuildVersion(42)).toHaveProperty("builtWithOpenClawVersion", undefined);
});
it("createPluginCandidatesFromManifestRegistry preserves child identity and ownership", () => {
  const childRecord = recordPluginManifestInstallOwner(
    { ...manifestRecord, id: "example/child" },
    "example",
  );

  const candidate = createPluginCandidatesFromManifestRegistry({
    plugins: [childRecord],
    diagnostics: [],
  })[0];
  expect(candidate).toMatchObject({
    idHint: "example/child",
    effectivePluginId: "example/child",
  });
  expect(resolvePluginCandidateInstallOwner(candidate!)).toBe("example");
});
it("does not accept a null source through the empty-schema fast path", () => {
  expect(validatePluginConfig({ schema: emptyObjectSchema, sourceValue: null, value: {} }).ok).toBe(
    false,
  );
});

it("returns an error instead of throwing when a schema is nested past the stack limit", () => {
  let schema: Record<string, unknown> = { type: "object" };
  for (let depth = 0; depth < 3_000; depth++) {
    schema = { type: "object", properties: { nested: schema } };
  }

  expect(validatePluginConfig({ schema, value: {} })).toMatchObject({ ok: false });
  expect(() => validatePluginConfigByOrigin({ origin: "bundled", schema, value: {} })).toThrow();
});

it("validates pattern properties instead of requiring empty config", () => {
  const schema = {
    ...emptyObjectSchema,
    patternProperties: { "^S_": { type: "string" } },
  };

  expect(validatePluginConfig({ schema, value: { S_SETTING: "configured" } })).toEqual({
    ok: true,
    value: { S_SETTING: "configured" },
  });
  expect(validatePluginConfig({ schema, value: { S_SETTING: 42 } })).toMatchObject({
    ok: false,
  });
});

afterAll(cleanupPluginLoaderFixturesForTest);

it.each(
  (["runtime", "cli", "descriptors"] as const).flatMap((surface) =>
    (["paired", "mixed-case", "candidate", "undeclared", "invalid-source"] as const).map(
      (scenario) => ({ surface, scenario }),
    ),
  ),
)(
  "$surface validates the exact source for declared secretInputs ($scenario)",
  async ({ surface, scenario }) => {
    await withOpenClawTestState(
      { label: "plugin-source-validation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const id = "source-fixture";
        const configId = scenario === "mixed-case" ? "Source-Fixture" : id;
        const descriptor = {
          name: "source-fixture",
          description: "Fixture command",
          hasSubcommands: false,
        };
        const configSchema = {
          type: "object",
          properties: {
            credential: credentialSchema,
            retries: { type: "integer", default: 2 },
            description: { type: "string" },
          },
          if: { properties: { credential: { properties: { id: { const: "KEY" } } } } },
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema branch data, not a promise method.
          then: { properties: { description: { default: "Fixture command" } } },
          else: { properties: { description: { default: "Alternate command" } } },
          required: ["credential"],
          additionalProperties: false,
        };
        const marker = state.statePath("fixture/imported");
        const entry = await state.writeText(
          "fixture/index.cjs",
          `
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "imported");
module.exports = { id: "source-fixture", register(api) {
  if (api.pluginConfig.credential !== "resolved-fixture-key" || api.pluginConfig.retries !== 2) {
    throw new Error("paired runtime config was not hydrated");
  }
  api.registerCli(() => {}, { descriptors: [{ ...${JSON.stringify(descriptor)}, description: api.pluginConfig.description }] });
} };`,
        );
        await state.writeJson("fixture/openclaw.plugin.json", {
          id,
          configSchema,
          cliCommands: [descriptor],
          configContracts:
            scenario === "undeclared"
              ? undefined
              : {
                  secretInputs: { paths: [{ path: "credential", expected: "string" }] },
                },
        });
        const runtime = withCredential(
          { plugins: { allow: [id], load: { paths: [entry] } } },
          configId,
          "resolved-fixture-key",
        );
        const source = withCredential(
          runtime,
          configId,
          scenario === "invalid-source" ? "invalid-plaintext-fixture" : credentialRef(),
        );
        const before = structuredClone({ runtime, source });
        setRuntimeConfigSnapshot(runtime, source);
        const config = scenario === "candidate" ? structuredClone(runtime) : runtime;
        const accepted = scenario === "paired" || scenario === "mixed-case";
        try {
          if (surface === "descriptors") {
            expect(await getPluginCliCommandDescriptors(config, state.env)).toEqual(
              accepted ? [descriptor] : [],
            );
            expect(fs.existsSync(marker)).toBe(false);
          } else {
            const messages: string[] = [];
            const options = {
              config,
              env: state.env,
              activate: false,
              logger: {
                info() {},
                warn() {},
                error(message: string) {
                  messages.push(message);
                },
              },
            };
            const load = (overrides: PluginLoadOptions) =>
              loadOpenClawPlugins({ ...options, ...overrides });
            const registry =
              surface === "runtime"
                ? loadOpenClawPlugins(options)
                : await loadOpenClawPluginCliRegistry(options);
            expect(registry.plugins.find((plugin) => plugin.id === id)?.status).toBe(
              accepted ? "loaded" : "error",
            );
            expect(cliDescriptors(registry)).toEqual(accepted ? [descriptor] : []);
            expect(fs.existsSync(marker)).toBe(accepted);
            if (surface === "runtime" && scenario === "paired") {
              const candidate = structuredClone(runtime);
              const expectCached = (overrides: PluginLoadOptions, expected = registry) =>
                expect(load(overrides) === expected).toBe(true);
              const unpaired = load({ config: candidate });
              expect
                .soft(unpaired.plugins.find((plugin) => plugin.id === id)?.status)
                .toBe("error");
              // Identity failures must not expand the registries' lazy runtime properties.
              expect.soft(unpaired === registry).toBe(false);
              expectCached({ config: candidate, activationSourceConfig: structuredClone(source) });

              const alternateSource = withCredential(source, id, credentialRef("OTHER"));
              const alternateOptions = {
                ...options,
                config: candidate,
                activationSourceConfig: alternateSource,
              };
              const alternate = load(alternateOptions);
              expect.soft(alternate === registry).toBe(false);
              const alternateDescriptors = [{ ...descriptor, description: "Alternate command" }];
              expect.soft(cliDescriptors(alternate)).toEqual(alternateDescriptors);
              expectCached(
                { ...alternateOptions, activationSourceConfig: structuredClone(alternateSource) },
                alternate,
              );

              const replacement = load({
                ...alternateOptions,
                cache: false,
                previousRegistry: registry,
              });
              expect(cliDescriptors(replacement)).toEqual(alternateDescriptors);
              for (const [change, enabled, secret, error] of [
                ["source-invalid", true, "resolved-fixture-key", "invalid config"],
                [
                  "resolved-secret",
                  true,
                  "rotated-fixture-key",
                  "paired runtime config was not hydrated",
                ],
                ["disabled", false, "resolved-fixture-key", "disabled"],
              ] as const) {
                const nextSource =
                  change === "resolved-secret" ? source : withCredential(source, id, null, enabled);
                const rejected = load({
                  config: withCredential(runtime, id, secret, enabled),
                  activationSourceConfig: nextSource,
                  cache: false,
                  previousRegistry: registry,
                });
                expect(rejected.cliRegistrars).toHaveLength(0);
                expect(rejected.plugins.find((plugin) => plugin.id === id)).toMatchObject({
                  status: enabled ? "error" : "disabled",
                  error: expect.stringContaining(error),
                });
              }

              setRuntimeConfigSnapshot(candidate, structuredClone(source));
              expect(getRuntimeConfigSnapshot()).toBe(runtime);
              expectCached({ config: runtime });
            }
            const output = JSON.stringify({ messages, diagnostics: registry.diagnostics });
            expect(output).not.toContain("resolved-fixture-key");
            expect(output).not.toContain("invalid-plaintext-fixture");
          }
          expect({ runtime, source }).toEqual(before);
        } finally {
          resetPluginLoaderTestStateForTest();
          const { failures } = await waitForPluginCacheRetirement();
          expect(failures, "Plugin cache retirement failed during cleanup").toEqual([]);
        }
      },
    );
  },
);
