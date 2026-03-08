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
  let dottedPluginDir = "";
  let workspacePluginDir = "";
  let voiceCallSchemaPluginDir = "";
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
    dottedPluginDir = path.join(suiteHome, "dotted-plugin");
    await writePluginFixture({
      dir: dottedPluginDir,
      id: "pack.one",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          permissionMode: { type: "string", enum: ["approve-all", "approve-reads"] },
        },
      },
    });
    workspacePluginDir = path.join(
      suiteHome,
      "workspace",
      ".openclaw",
      "extensions",
      "workspace-hint",
    );
    await writePluginFixture({
      dir: workspacePluginDir,
      id: "workspace-hint",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          queueOwnerTtlSeconds: { type: "number", minimum: 0 },
        },
      },
    });
    voiceCallSchemaPluginDir = path.join(suiteHome, "voice-call-schema-plugin");
    const voiceCallManifestPath = path.join(
      process.cwd(),
      "extensions",
      "voice-call",
      "openclaw.plugin.json",
    );
    const voiceCallManifest = JSON.parse(await fs.readFile(voiceCallManifestPath, "utf-8")) as {
      configSchema?: Record<string, unknown>;
    };
    if (!voiceCallManifest.configSchema) {
      throw new Error("voice-call manifest missing configSchema");
    }
    await writePluginFixture({
      dir: voiceCallSchemaPluginDir,
      id: "voice-call-schema-fixture",
      schema: voiceCallManifest.configSchema,
    });
    process.env.OPENCLAW_STATE_DIR = path.join(suiteHome, ".openclaw");
    process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS = "10000";
    clearPluginManifestRegistryCache();
    // Warm the plugin manifest cache once so path-based validations can reuse
    // parsed manifests across test cases.
    validateInSuite({
      plugins: {
        enabled: false,
        load: {
          paths: [badPluginDir, bluebubblesPluginDir, dottedPluginDir, voiceCallSchemaPluginDir],
        },
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

  it("accepts voice-call webhookSecurity and streaming guard config fields", async () => {
    const res = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [voiceCallSchemaPluginDir] },
        entries: {
          "voice-call-schema-fixture": {
            config: {
              provider: "twilio",
              webhookSecurity: {
                allowedHosts: ["voice.example.com"],
                trustForwardingHeaders: false,
                trustedProxyIPs: ["127.0.0.1"],
              },
              streaming: {
                enabled: true,
                preStartTimeoutMs: 5000,
                maxPendingConnections: 16,
                maxPendingConnectionsPerIp: 4,
                maxConnections: 64,
              },
              staleCallReaperSeconds: 180,
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("suggests .config nesting for misplaced plugin config keys", async () => {
    const wrong = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            permissionMode: "approve-all",
          },
        },
      },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.issues).toContainEqual({
        path: "plugins.entries.acpx",
        message:
          'Unrecognized key: "permissionMode". Did you mean "plugins.entries.acpx.config.permissionMode"?',
      });
    }

    const right = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            config: {
              permissionMode: "approve-all",
            },
          },
        },
      },
    });
    expect(right.ok).toBe(true);
  });

  it("suggests .config nesting for dotted plugin ids too", async () => {
    const wrong = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        enabled: true,
        load: { paths: [dottedPluginDir] },
        entries: {
          "pack.one": {
            enabled: true,
            permissionMode: "approve-all",
          },
        },
      },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.issues).toContainEqual({
        path: "plugins.entries.pack.one",
        message:
          'Unrecognized key: "permissionMode". Did you mean "plugins.entries.pack.one.config.permissionMode"?',
      });
    }
  });

  it("suggests .config nesting for multiple misplaced plugin config keys", async () => {
    const wrong = validateInSuite({
      agents: { list: [{ id: "pi" }] },
      plugins: {
        entries: {
          acpx: {
            enabled: true,
            permissionMode: "approve-all",
            nonInteractivePermissions: "fail",
          },
        },
      },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.issues).toContainEqual({
        path: "plugins.entries.acpx",
        message:
          'Unrecognized keys: "permissionMode", "nonInteractivePermissions". Did you mean "plugins.entries.acpx.config.permissionMode", "plugins.entries.acpx.config.nonInteractivePermissions"?',
      });
    }
  });

  it("suggests .config nesting for workspace-installed plugins", async () => {
    const wrong = validateInSuite({
      agents: {
        defaults: {
          workspace: path.join(suiteHome, "workspace"),
        },
        list: [{ id: "pi" }],
      },
      plugins: {
        entries: {
          "workspace-hint": {
            enabled: true,
            queueOwnerTtlSeconds: 5,
          },
        },
      },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.issues).toContainEqual({
        path: "plugins.entries.workspace-hint",
        message:
          'Unrecognized key: "queueOwnerTtlSeconds". Did you mean "plugins.entries.workspace-hint.config.queueOwnerTtlSeconds"?',
      });
    }
  });

  it("keeps workspace plugin hints even when unrelated agents config is invalid", async () => {
    const wrong = validateInSuite({
      agents: {
        defaults: {
          workspace: path.join(suiteHome, "workspace"),
          timeoutSeconds: "nope",
        },
        list: [{ id: "pi" }],
      },
      plugins: {
        entries: {
          "workspace-hint": {
            enabled: true,
            queueOwnerTtlSeconds: 5,
          },
        },
      },
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) {
      expect(wrong.issues).toEqual(
        expect.arrayContaining([
          {
            path: "agents.defaults.timeoutSeconds",
            message: expect.stringContaining("number"),
          },
          {
            path: "plugins.entries.workspace-hint",
            message:
              'Unrecognized key: "queueOwnerTtlSeconds". Did you mean "plugins.entries.workspace-hint.config.queueOwnerTtlSeconds"?',
          },
        ]),
      );
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
});
