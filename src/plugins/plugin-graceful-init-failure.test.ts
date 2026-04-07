import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-plugin-graceful", fixtureTempDirs);
let tempDirIndex = 0;

afterAll(() => {
  cleanupTrackedTempDirs(fixtureTempDirs);
});

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(params: { id: string; body: string; dir?: string }): {
  id: string;
  file: string;
  dir: string;
} {
  const dir = params.dir ?? makeTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${params.id}.cjs`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      name: params.id,
      version: "1.0.0",
      main: filename,
      configSchema: { type: "object" },
    }),
    "utf-8",
  );
  return { id: params.id, file, dir };
}

function readPluginId(pluginPath: string): string {
  const manifestPath = path.join(path.dirname(pluginPath), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { id: string };
  return manifest.id;
}

async function loadPlugins(pluginPaths: string[], warnings?: string[]) {
  const { loadOpenClawPlugins, clearPluginLoaderCache } = await import("./loader.js");
  clearPluginLoaderCache();
  const allow = pluginPaths.map((pluginPath) => readPluginId(pluginPath));
  return loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        enabled: true,
        load: { paths: pluginPaths },
        allow,
      },
    },
    logger: {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (message: string) => warnings?.push(message),
    },
  });
}

describe("graceful plugin initialization failure", () => {
  it("does not crash when register throws", async () => {
    const plugin = writePlugin({
      id: "throws-on-register",
      body: `module.exports = { id: "throws-on-register", register() { throw new Error("config schema mismatch"); } };`,
    });

    await expect(loadPlugins([plugin.file])).resolves.toBeDefined();
  });

  it("keeps loading other plugins after one register failure", async () => {
    const failing = writePlugin({
      id: "plugin-fail",
      body: `module.exports = { id: "plugin-fail", register() { throw new Error("boom"); } };`,
    });
    const working = writePlugin({
      id: "plugin-ok",
      body: `module.exports = { id: "plugin-ok", register() {} };`,
    });

    const registry = await loadPlugins([failing.file, working.file]);

    expect(registry.plugins.find((plugin) => plugin.id === "plugin-ok")?.status).toBe("loaded");
  });

  it("records failed register metadata", async () => {
    const plugin = writePlugin({
      id: "register-error",
      body: `module.exports = { id: "register-error", register() { throw new Error("brutal config fail"); } };`,
    });

    const before = new Date();
    const registry = await loadPlugins([plugin.file]);
    const after = new Date();

    const failed = registry.plugins.find((entry) => entry.id === "register-error");
    expect(failed).toBeDefined();
    expect(failed?.status).toBe("error");
    expect(failed?.failurePhase).toBe("register");
    expect(failed?.error).toContain("brutal config fail");
    expect(failed?.failedAt).toBeInstanceOf(Date);
    expect(failed?.failedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(failed?.failedAt?.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("records validation failures before register", async () => {
    const plugin = writePlugin({
      id: "missing-register",
      body: `module.exports = { id: "missing-register" };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const failed = registry.plugins.find((entry) => entry.id === "missing-register");

    expect(failed?.status).toBe("error");
    expect(failed?.failurePhase).toBe("validation");
    expect(failed?.error).toBe("plugin export missing register/activate");
  });

  it("logs a startup summary grouped by failure phase", async () => {
    const registerFailure = writePlugin({
      id: "warn-register",
      body: `module.exports = { id: "warn-register", register() { throw new Error("bad config"); } };`,
    });
    const validationFailure = writePlugin({
      id: "warn-validation",
      body: `module.exports = { id: "warn-validation" };`,
    });

    const warnings: string[] = [];
    await loadPlugins([registerFailure.file, validationFailure.file], warnings);

    const summary = warnings.find((warning) => warning.includes("failed to initialize"));
    expect(summary).toBeDefined();
    expect(summary).toContain("register: warn-register");
    expect(summary).toContain("validation: warn-validation");
    expect(summary).toContain("openclaw plugins list");
  });
});

describe("plugin module default-unwrapping", () => {
  it("loads plugins exported through nested default wrappers", async () => {
    const plugin = writePlugin({
      id: "nested-default-wrapper",
      body: `module.exports = { default: { default: { id: "nested-default-wrapper", register() {} } } };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const loaded = registry.plugins.find((entry) => entry.id === "nested-default-wrapper");

    expect(loaded?.status).toBe("loaded");
    expect(loaded?.failurePhase).toBeUndefined();
  });

  it("does not unwrap past a plugin definition that includes a default field", async () => {
    const plugin = writePlugin({
      id: "nested-default-with-definition-default",
      body: `module.exports = { default: { id: "nested-default-with-definition-default", register() {}, default: { marker: true } } };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const loaded = registry.plugins.find(
      (entry) => entry.id === "nested-default-with-definition-default",
    );

    expect(loaded?.status).toBe("loaded");
    expect(loaded?.failurePhase).toBeUndefined();
  });

  it("prefers default plugin definitions over wrapper-level named register exports", async () => {
    const plugin = writePlugin({
      id: "nested-default-wrapper-with-named-register",
      body: `module.exports = { register() { throw new Error("wrapper register should not run"); }, default: { id: "nested-default-wrapper-with-named-register", register() {} } };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const loaded = registry.plugins.find(
      (entry) => entry.id === "nested-default-wrapper-with-named-register",
    );

    expect(loaded?.status).toBe("loaded");
    expect(loaded?.failurePhase).toBeUndefined();
    expect(loaded?.error).toBeUndefined();
  });

  it("prefers default function exports over wrapper-level named register exports", async () => {
    const plugin = writePlugin({
      id: "nested-default-wrapper-with-default-function",
      body: `module.exports = { register() { throw new Error("wrapper register should not run"); }, default() {} };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const loaded = registry.plugins.find(
      (entry) => entry.id === "nested-default-wrapper-with-default-function",
    );

    expect(loaded?.status).toBe("loaded");
    expect(loaded?.failurePhase).toBeUndefined();
    expect(loaded?.error).toBeUndefined();
  });

  it("unwraps nested default wrappers even when outer wrapper has named register", async () => {
    const plugin = writePlugin({
      id: "nested-default-wrapper-with-nested-default-object",
      body: `module.exports = { register() { throw new Error("wrapper register should not run"); }, default: { default: { id: "nested-default-wrapper-with-nested-default-object", register() {} } } };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const loaded = registry.plugins.find(
      (entry) => entry.id === "nested-default-wrapper-with-nested-default-object",
    );

    expect(loaded?.status).toBe("loaded");
    expect(loaded?.failurePhase).toBeUndefined();
    expect(loaded?.error).toBeUndefined();
  });
});
