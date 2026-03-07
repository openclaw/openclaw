import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./config.js";

async function writePluginFixture(params: {
  dir: string;
  id: string;
  schema: Record<string, unknown>;
  channels?: string[];
}) {
  await fs.mkdir(params.dir, { recursive: true });
  await fs.writeFile(
    path.join(params.dir, "index.js"),
    `export default { id: "${params.id}", register() {} };`,
    "utf-8",
  );
  const manifest: Record<string, unknown> = {
    id: params.id,
    configSchema: params.schema,
  };
  if (params.channels) {
    manifest.channels = params.channels;
  }
  await fs.writeFile(
    path.join(params.dir, "openclaw.plugin.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

describe("config plugin validation", () => {
  let fixtureRoot = "";
  let suiteHome = "";
  let badPluginDir = "";
  let enumPluginDir = "";
  let bluebubblesPluginDir = "";
  const envSnapshot = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS,
  };

  const validateInSuite = (raw: unknown) => validateConfigObjectWithPlugins(raw);

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-plugin-validation-"));
    suiteHome = path.join(fixtureRoot, "home");
    await fs.mkdir(suiteHome, { recursive: true });
    badPluginDir = path.join(suiteHome, "bad-plugin");
    enumPluginDir = path.join(suiteHome, "enum-plugin");
    bluebubblesPluginDir = path.join(suiteHome, "bluebubbles-plugin");
    await writePluginFixture({
      dir: badPluginDir,
      id: "bad-plugin",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "boolean" },
        },
        required: ["value"],
      },
    });
    await writePluginFixture({
      dir: enumPluginDir,
      id: "enum-plugin",
      schema: {
        type: "object",
        properties: {
          fileFormat: {
            type: "string",
            enum: ["markdown", "html"],
          },
        },
        required: ["fileFormat"],
      },
    });
    await writePluginFixture({
      dir: bluebubblesPluginDir,
      id: "bluebubbles-plugin",
      channels: ["bluebubbles"],
      schema: { type: "object" },
    });
    process.env.OPENCLAW_STATE_DIR = path.join(suiteHome, ".openclaw");
    process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS = "10000";
    clearPluginManifestRegistryCache();
    // Warm the plugin manifest cache once so path-based validations can reuse
    // parsed manifests across test cases.
    validateInSuite({
      plugins: {
        enabled: false,
        load: { paths: [badPluginDir, bluebubblesPluginDir] },
      },
    });
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    clearPluginManifestRegistryCache();
    if (envSnapshot.OPENCLAW_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = envSnapshot.OPENCLAW_STATE_DIR;
    }
    if (envSnapshot.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS === undefined) {
      delete process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS;
    } else {
      process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS = envSnapshot.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS;
    }
  });

  it("reports missing plugin refs across load paths, entries, and allowlist surfaces", async () => {
    const missingPath = path.join(suiteHome, "missing-plugin-dir");
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        load: { paths: [missingPath] },
        entries: { "missing-plugin": { enabled: true } },
        allow: ["missing-allow"],
        deny: ["missing-deny"],
        slots: { memory: "missing-slot" },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path === "plugins.load.paths" && issue.message.includes("plugin path not found"),
        ),
      ).toBe(true);
      expect(res.issues).toEqual(
        expect.arrayContaining([
          { path: "plugins.allow", message: "plugin not found: missing-allow" },
          { path: "plugins.deny", message: "plugin not found: missing-deny" },
          { path: "plugins.slots.memory", message: "plugin not found: missing-slot" },
        ]),
      );
      expect(res.warnings).toContainEqual({
        path: "plugins.entries.missing-plugin",
        message:
          "plugin not found: missing-plugin (stale config entry ignored; remove it from plugins config)",
      });
    }
  });

  it("warns for removed legacy plugin ids instead of failing validation", async () => {
    const removedId = "google-antigravity-auth";
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: false,
        entries: { [removedId]: { enabled: true } },
        allow: [removedId],
        deny: [removedId],
        slots: { memory: removedId },
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.warnings).toEqual(
        expect.arrayContaining([
          {
            path: `plugins.entries.${removedId}`,
            message:
              "plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
          },
          {
            path: "plugins.allow",
            message:
              "plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
          },
          {
            path: "plugins.deny",
            message:
              "plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
          },
          {
            path: "plugins.slots.memory",
            message:
              "plugin removed: google-antigravity-auth (stale config entry ignored; remove it from plugins config)",
          },
        ]),
      );
    }
  });

  it("surfaces plugin config diagnostics", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [badPluginDir] },
        entries: { "bad-plugin": { config: { value: "nope" } } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const hasIssue = res.issues.some(
        (issue) =>
          issue.path.startsWith("plugins.entries.bad-plugin.config") &&
          issue.message.includes("invalid config"),
      );
      expect(hasIssue).toBe(true);
    }
  });

  it("surfaces allowed enum values for plugin config diagnostics", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [enumPluginDir] },
        entries: { "enum-plugin": { config: { fileFormat: "txt" } } },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issue = res.issues.find(
        (entry) => entry.path === "plugins.entries.enum-plugin.config.fileFormat",
      );
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('allowed: "markdown", "html"');
      expect(issue?.allowedValues).toEqual(["markdown", "html"]);
      expect(issue?.allowedValuesHiddenCount).toBe(0);
    }
  });

  it("accepts known plugin ids and valid channel/heartbeat enums", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { target: "last", directPolicy: "block" } },
        list: [{ id: "pi", heartbeat: { directPolicy: "allow" } }],
      },
      channels: {
        modelByChannel: {
          openai: {
            whatsapp: "openai/gpt-5.2",
          },
        },
      },
      plugins: { enabled: false, entries: { discord: { enabled: true } } },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts plugin heartbeat targets", async () => {
    const res = validateInSuite({
      agents: { defaults: { heartbeat: { target: "bluebubbles" } }, list: [{ id: "pi" }] },
      plugins: { enabled: false, load: { paths: [bluebubblesPluginDir] } },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown heartbeat targets", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { target: "not-a-channel" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues).toContainEqual({
        path: "agents.defaults.heartbeat.target",
        message: "unknown heartbeat target: not-a-channel",
      });
    }
  });

  it("rejects invalid heartbeat directPolicy values", async () => {
    const res = validateInSuite({
      agents: {
        defaults: { heartbeat: { directPolicy: "maybe" } },
        list: [{ id: "pi" }],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some((issue) => issue.path === "agents.defaults.heartbeat.directPolicy"),
      ).toBe(true);
    }
  });

  it("accepts memorySearch provider when it matches memory slot plugin", async () => {
    const memoryPluginDir = path.join(suiteHome, "memory-openviking-plugin");
    await writePluginFixture({
      dir: memoryPluginDir,
      id: "memory-openviking",
      schema: { type: "object" },
    });
    await fs.writeFile(
      path.join(memoryPluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "memory-openviking",
          kind: "memory",
          configSchema: { type: "object" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearPluginManifestRegistryCache();

    const res = validateInSuite({
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-openviking",
          },
        },
      },
      plugins: {
        load: { paths: [memoryPluginDir] },
        slots: { memory: "memory-openviking" },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects memorySearch plugin provider when memory slot differs", async () => {
    const memoryPluginDir = path.join(suiteHome, "memory-custom-plugin");
    await writePluginFixture({
      dir: memoryPluginDir,
      id: "memory-custom",
      schema: { type: "object" },
    });
    await fs.writeFile(
      path.join(memoryPluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "memory-custom",
          kind: "memory",
          configSchema: { type: "object" },
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearPluginManifestRegistryCache();

    const res = validateInSuite({
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-custom",
          },
        },
      },
      plugins: {
        load: { paths: [memoryPluginDir] },
        slots: { memory: "memory-core" },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path === "agents.defaults.memorySearch.provider" &&
            issue.message.includes("must match plugins.slots.memory"),
        ),
      ).toBe(true);
    }
  });

  it('rejects memorySearch provider "memory-core" as reserved bundled slot id', async () => {
    const res = validateInSuite({
      agents: {
        defaults: {
          memorySearch: {
            provider: "memory-core",
          },
        },
      },
      plugins: {
        slots: { memory: "memory-core" },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path === "agents.defaults.memorySearch.provider" &&
            issue.message.includes('provider "memory-core" is reserved'),
        ),
      ).toBe(true);
    }
  });
});
