import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-plugin-graceful", fixtureTempDirs);
let tempDirIndex = 0;
const { loadOpenClawPlugins, clearPluginLoaderCache } = await import("./loader.test-fixtures.js");
const validationState = { status: "error", failurePhase: "validation" } as const;

afterAll(() => cleanupTrackedTempDirs(fixtureTempDirs));

function writePlugin(
  id: string,
  params: {
    body?: string;
    configSchema?: Record<string, unknown>;
    configSchemaJson?: string;
  } = {},
) {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  const filename = `${id}.cjs`;
  const configSchemaJson =
    params.configSchemaJson ?? JSON.stringify(params.configSchema ?? { type: "object" });
  writeTree(dir, {
    [filename]: params.body ?? `module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
    "openclaw.plugin.json": `{"id":${JSON.stringify(id)},"configSchema":${configSchemaJson}}`,
  });
  return { id, file: path.join(dir, filename) };
}

async function loadPlugins(
  plugins: ReturnType<typeof writePlugin>[],
  warnings?: string[],
  previousRegistry?: NonNullable<Parameters<typeof loadOpenClawPlugins>[0]>["previousRegistry"],
) {
  clearPluginLoaderCache();
  const allow = plugins.map(({ id }) => id);
  return loadOpenClawPlugins({
    cache: false,
    previousRegistry,
    config: {
      plugins: {
        enabled: true,
        load: { paths: plugins.map(({ file }) => file) },
        allow,
      },
    },
    installRecords: {},
    logger: {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (message: string) => warnings?.push(message),
    },
    onlyPluginIds: allow,
    workspaceDir: fixtureRoot,
  });
}

function requirePluginEntry(registry: Awaited<ReturnType<typeof loadPlugins>>, pluginId: string) {
  const entry = registry.plugins.find((plugin) => plugin.id === pluginId);
  if (!entry) {
    throw new Error(`expected ${pluginId} registry entry`);
  }
  return entry;
}

it("records a malformed configSchema as a validation failure", async () => {
  const broken = writePlugin("unresolved-ref-plugin", {
    configSchema: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } },
  });

  const registry = await loadPlugins([broken]);

  const failed = requirePluginEntry(registry, "unresolved-ref-plugin");
  expect(failed).toMatchObject({
    ...validationState,
    error: expect.stringContaining("invalid schema"),
  });
});

it("keeps loading siblings and retries validation when a schema cannot be serialized", async () => {
  // Serialize the fixture without spending the stack that validation must contain.
  const deep =
    '{"type":"object","properties":{"nested":'.repeat(3_000) +
    '{"type":"object"}' +
    "}}".repeat(3_000);
  const broken = writePlugin("deep-schema-plugin", { configSchemaJson: deep });
  const healthy = writePlugin("shallow-schema-plugin");

  const brokenSource = fs.realpathSync(broken.file);
  const stringify = JSON.stringify;
  let signatureFailures = 0;
  // Native serialization limits differ; only the broken candidate's retention signature fails.
  const serialization = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    if (Array.isArray(value) && value[0] === brokenSource) {
      signatureFailures++;
      throw new RangeError("fixture retention signature exceeds serialization limits");
    }
    return stringify(value, ...args);
  });
  try {
    const registry = await loadPlugins([broken, healthy]);

    const loaded = requirePluginEntry(registry, healthy.id);
    const failed = requirePluginEntry(registry, broken.id);
    expect(loaded.status).toBe("loaded");
    expect(failed).toMatchObject(validationState);
    const replacement = await loadPlugins([broken, healthy], undefined, registry);
    expect(requirePluginEntry(replacement, healthy.id)).toBe(loaded);
    expect(requirePluginEntry(replacement, broken.id)).toMatchObject(validationState);
    expect(requirePluginEntry(replacement, broken.id)).not.toBe(failed);
    expect(signatureFailures).toBe(2);
  } finally {
    serialization.mockRestore();
  }
});

it("rolls back partial metadata without breaking an earlier class-backed service", async () => {
  const stable = writePlugin("a-stable-service-plugin", {
    body: `class StableService {
        constructor() { this.id = "stable-service"; }
        start() {}
        ping() { return "still-alive"; }
      }
      module.exports = { id: "a-stable-service-plugin", register(api) {
        api.registerService(new StableService());
      } };`,
  });
  const failing = writePlugin("z-partial-register-failure", {
    body: `module.exports = { id: "z-partial-register-failure", register(api) {
        api.registerService({ id: "failed-service", start() {} });
        api.registerHttpRoute({ path: "/failed", auth: "plugin", handler: async () => true });
        throw new Error("fail after partial registration");
      } };`,
  });

  const registry = await loadPlugins([stable, failing]);
  const failed = requirePluginEntry(registry, "z-partial-register-failure");
  const stableService = registry.services.find((entry) => entry.service.id === "stable-service")
    ?.service as { ping?: () => string } | undefined;

  expect(failed).toMatchObject({ status: "error", httpRoutes: 0 });
  expect(failed.services).toEqual([]);
  expect(registry.services.map((entry) => entry.service.id)).toEqual(["stable-service"]);
  expect(registry.httpRoutes).toEqual([]);
  expect(stableService?.ping?.()).toBe("still-alive");
});

it("logs a startup summary grouped by failure phase", async () => {
  const registerFailure = writePlugin("warn-register", {
    body: `module.exports = { id: "warn-register", register() { throw new Error("bad config"); } };`,
  });
  const validationFailure = writePlugin("warn-validation", {
    body: `module.exports = { id: "warn-validation" };`,
  });

  const warnings: string[] = [];
  await loadPlugins([registerFailure, validationFailure], warnings);

  const summary = warnings.find((warning) => warning.includes("failed to initialize"));
  expect(summary).toContain("register: warn-register");
  expect(summary).toContain("validation: warn-validation");
  expect(summary).toContain("openclaw plugins inspect <id> --runtime --json");
  expect(summary).toContain("openclaw plugins list");
});
