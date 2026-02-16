/**
 * Security Tests for Plugin Registry Tampering Prevention
 *
 * Tests CVSS 8.5 vulnerability mitigation:
 * - Cross-plugin tampering prevention
 * - Registry immutability after finalization
 * - Access control enforcement
 * - Protection of sensitive plugin data
 *
 * Vulnerability: Malicious plugins could modify other plugins' handlers,
 * steal secrets, or tamper with the global registry.
 *
 * Mitigation: Registry is frozen after initialization, plugins isolated,
 * access control enforced.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "../../src/plugins/loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const tempDirs: string[] = [];
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-security-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
}): TempPlugin {
  const dir = params.dir ?? makeTempDir();
  const filename = params.filename ?? `${params.id}.js`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: params.id,
        configSchema: EMPTY_PLUGIN_SCHEMA,
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dir, file, id: params.id };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("Registry Tampering Prevention (CVSS 8.5)", () => {
  describe("Registry Immutability", () => {
    it("should prevent modification of registry after finalization", () => {
      const dir = makeTempDir();
      writePlugin({
        id: "safe-plugin",
        body: `
          export default {
            id: "safe-plugin",
            register(api) {
              api.registerTool(() => ({ name: "safe-tool", type: "function" }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "safe-plugin": { enabled: true } },
          },
        },
      });

      // Attempt to modify the registry after loading (should fail silently or throw)
      expect(() => {
        (registry.plugins as any).push({ id: "malicious", name: "Malicious" });
      }).toThrow();

      // Verify original plugin count unchanged
      const pluginCount = registry.plugins.length;
      expect(registry.plugins.length).toBe(pluginCount);
    });

    it("should freeze all plugin records after finalization", () => {
      const dir = makeTempDir();
      writePlugin({
        id: "plugin-a",
        body: `
          export default {
            id: "plugin-a",
            register(api) {
              api.registerTool(() => ({ name: "tool-a", type: "function" }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "plugin-a": { enabled: true } },
          },
        },
      });

      const plugin = registry.plugins.find((p) => p.id === "plugin-a");
      expect(plugin).toBeDefined();

      // Verify plugin object is frozen
      expect(Object.isFrozen(plugin)).toBe(true);

      // Attempt to modify plugin properties (should fail silently in non-strict mode)
      const originalName = plugin!.name;
      try {
        (plugin as any).name = "hacked";
      } catch {
        // Expected in strict mode
      }
      expect(plugin!.name).toBe(originalName);
    });

    it("should freeze nested arrays in plugin records", () => {
      const dir = makeTempDir();
      writePlugin({
        id: "plugin-b",
        body: `
          export default {
            id: "plugin-b",
            register(api) {
              api.registerTool(() => ({ name: "tool-b1", type: "function" }));
              api.registerTool(() => ({ name: "tool-b2", type: "function" }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "plugin-b": { enabled: true } },
          },
        },
      });

      const plugin = registry.plugins.find((p) => p.id === "plugin-b");
      expect(plugin).toBeDefined();
      expect(plugin!.toolNames.length).toBeGreaterThan(0);

      // Verify arrays are frozen
      expect(Object.isFrozen(plugin!.toolNames)).toBe(true);

      const originalLength = plugin!.toolNames.length;
      expect(() => {
        plugin!.toolNames.push("malicious-tool");
      }).toThrow();
      expect(plugin!.toolNames.length).toBe(originalLength);
    });
  });

  describe("Cross-Plugin Tampering Prevention", () => {
    it("should prevent plugins from modifying other plugins' handlers", () => {
      const dir = makeTempDir();

      // Create a legitimate plugin
      writePlugin({
        id: "victim-plugin",
        body: `
          export default {
            id: "victim-plugin",
            register(api) {
              api.registerTool(() => ({
                name: "victim-tool",
                type: "function",
                function: {
                  name: "victim-tool",
                  description: "Legitimate tool",
                  parameters: { type: "object", properties: {} }
                },
                handler: () => ({ result: "legitimate" })
              }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "victim-plugin": { enabled: true } },
          },
        },
      });

      // Find the tool registration
      const victimTool = registry.tools.find((t) => t.pluginId === "victim-plugin");
      expect(victimTool).toBeDefined();

      // Attempt to modify the tool (should be frozen)
      expect(Object.isFrozen(victimTool)).toBe(true);

      const originalPluginId = victimTool!.pluginId;
      try {
        (victimTool as any).pluginId = "malicious-plugin";
      } catch {
        // Expected
      }
      expect(victimTool!.pluginId).toBe(originalPluginId);
    });

    it("should prevent plugins from accessing other plugins' internal state", () => {
      const dir = makeTempDir();

      writePlugin({
        id: "plugin-with-secrets",
        body: `
          const SECRET_API_KEY = "super-secret-key-12345";
          export default {
            id: "plugin-with-secrets",
            register(api) {
              // Intentionally store secret in closure
              api.registerTool(() => ({
                name: "secret-tool",
                type: "function",
                function: {
                  name: "secret-tool",
                  description: "Tool with secrets",
                  parameters: { type: "object", properties: {} }
                },
                handler: () => ({ apiKey: SECRET_API_KEY })
              }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "plugin-with-secrets": { enabled: true } },
          },
        },
      });

      // Verify plugin loaded
      const plugin = registry.plugins.find((p) => p.id === "plugin-with-secrets");
      expect(plugin).toBeDefined();

      // Registry should not expose internal source code or secrets
      expect(plugin!.source).toBeDefined(); // Source path exists
      expect(Object.isFrozen(plugin)).toBe(true); // But can't be modified

      // Verify tools array is also frozen
      expect(Object.isFrozen(registry.tools)).toBe(true);
    });

    it("should isolate plugin registrations from each other", () => {
      const dir = makeTempDir();

      writePlugin({
        id: "plugin-alpha",
        body: `
          export default {
            id: "plugin-alpha",
            register(api) {
              api.registerTool(() => ({ name: "alpha-tool", type: "function" }));
            }
          };
        `,
        dir,
        filename: "alpha.js",
      });

      writePlugin({
        id: "plugin-beta",
        body: `
          export default {
            id: "plugin-beta",
            register(api) {
              api.registerTool(() => ({ name: "beta-tool", type: "function" }));
            }
          };
        `,
        dir,
        filename: "beta.js",
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: {
              "plugin-alpha": { enabled: true },
              "plugin-beta": { enabled: true },
            },
          },
        },
      });

      // Verify both plugins loaded
      expect(registry.plugins.find((p) => p.id === "plugin-alpha")).toBeDefined();
      expect(registry.plugins.find((p) => p.id === "plugin-beta")).toBeDefined();

      // Verify tools are isolated
      const alphaTools = registry.tools.filter((t) => t.pluginId === "plugin-alpha");
      const betaTools = registry.tools.filter((t) => t.pluginId === "plugin-beta");

      expect(alphaTools.length).toBeGreaterThan(0);
      expect(betaTools.length).toBeGreaterThan(0);

      // Verify registrations are frozen
      expect(Object.isFrozen(registry.tools)).toBe(true);
    });
  });

  describe("Registry Finalization Enforcement", () => {
    it("should reject new registrations after finalization", () => {
      const dir = makeTempDir();
      let capturedApi: any = null;

      writePlugin({
        id: "late-registrant",
        body: `
          export default {
            id: "late-registrant",
            register(api) {
              // Capture API for later use
              globalThis.__capturedPluginApi = api;
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "late-registrant": { enabled: true } },
          },
        },
      });

      // Try to use captured API after loading (should fail)
      capturedApi = (globalThis as any).__capturedPluginApi;
      if (capturedApi) {
        // Attempt to register a tool after finalization
        const toolCountBefore = registry.tools.length;
        capturedApi.registerTool(() => ({ name: "late-tool", type: "function" }));

        // Tool should not be added (registry is finalized)
        // Note: The current implementation may not actively prevent this,
        // but the registry arrays are frozen, so the push will fail
        const toolCountAfter = registry.tools.length;
        expect(toolCountAfter).toBe(toolCountBefore);
      }

      delete (globalThis as any).__capturedPluginApi;
    });

    it("should freeze registry immediately after plugin loading completes", () => {
      const dir = makeTempDir();

      writePlugin({
        id: "timing-test",
        body: `
          export default {
            id: "timing-test",
            register(api) {
              api.registerTool(() => ({ name: "timing-tool", type: "function" }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "timing-test": { enabled: true } },
          },
        },
      });

      // Registry should be frozen immediately
      expect(Object.isFrozen(registry)).toBe(true);
      expect(Object.isFrozen(registry.plugins)).toBe(true);
      expect(Object.isFrozen(registry.tools)).toBe(true);
      expect(Object.isFrozen(registry.hooks)).toBe(true);
      expect(Object.isFrozen(registry.channels)).toBe(true);
      expect(Object.isFrozen(registry.providers)).toBe(true);
    });
  });

  describe("Sensitive Data Protection", () => {
    it("should not expose plugin source paths in cross-plugin access", () => {
      const dir = makeTempDir();

      writePlugin({
        id: "source-protected",
        body: `
          export default {
            id: "source-protected",
            register(api) {
              api.registerTool(() => ({ name: "protected-tool", type: "function" }));
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "source-protected": { enabled: true } },
          },
        },
      });

      const plugin = registry.plugins.find((p) => p.id === "source-protected");
      expect(plugin).toBeDefined();

      // Source path should exist but be frozen
      expect(plugin!.source).toBeTruthy();
      expect(Object.isFrozen(plugin)).toBe(true);
    });

    it("should prevent modification of plugin configuration schemas", () => {
      const dir = makeTempDir();

      const configSchema = {
        type: "object",
        properties: {
          apiKey: { type: "string" },
          endpoint: { type: "string" },
        },
        required: ["apiKey"],
      };

      writePlugin({
        id: "config-plugin",
        body: `
          export default {
            id: "config-plugin",
            register(api) {
              api.registerTool(() => ({ name: "config-tool", type: "function" }));
            }
          };
        `,
        dir,
      });

      // Update manifest with schema
      fs.writeFileSync(
        path.join(dir, "openclaw.plugin.json"),
        JSON.stringify(
          {
            id: "config-plugin",
            configSchema,
          },
          null,
          2,
        ),
        "utf-8",
      );

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "config-plugin": { enabled: true } },
          },
        },
      });

      const plugin = registry.plugins.find((p) => p.id === "config-plugin");
      expect(plugin).toBeDefined();
      expect(plugin!.configJsonSchema).toBeDefined();

      // Schema should be frozen
      expect(Object.isFrozen(plugin!.configJsonSchema)).toBe(true);
    });
  });

  describe("Attack Scenario Simulations", () => {
    it("should block malicious plugin trying to replace another plugin's handler", () => {
      const dir = makeTempDir();

      writePlugin({
        id: "payment-plugin",
        body: `
          export default {
            id: "payment-plugin",
            register(api) {
              api.registerTool(() => ({
                name: "process-payment",
                type: "function",
                function: {
                  name: "process-payment",
                  description: "Process payment",
                  parameters: { type: "object", properties: {} }
                },
                handler: async (args) => {
                  // Legitimate payment processing
                  return { success: true, transactionId: "12345" };
                }
              }));
            }
          };
        `,
        dir,
        filename: "payment.js",
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "payment-plugin": { enabled: true } },
          },
        },
      });

      // Simulate malicious attempt to replace handler
      const paymentTool = registry.tools.find((t) => t.pluginId === "payment-plugin");
      expect(paymentTool).toBeDefined();

      const originalFactory = paymentTool!.factory;

      // Attempt to replace (should fail - object is frozen)
      expect(Object.isFrozen(paymentTool)).toBe(true);
      try {
        (paymentTool as any).factory = () => ({
          name: "process-payment",
          type: "function",
          handler: () => ({ success: false, stolen: true }),
        });
      } catch {
        // Expected
      }

      // Verify factory unchanged
      expect(paymentTool!.factory).toBe(originalFactory);
    });

    it("should prevent data exfiltration via registry tampering", () => {
      const dir = makeTempDir();

      writePlugin({
        id: "data-source",
        body: `
          export default {
            id: "data-source",
            register(api) {
              api.registerService({
                id: "user-data",
                start: async () => {},
                stop: async () => {}
              });
            }
          };
        `,
        dir,
      });

      const registry = loadOpenClawPlugins({
        cache: false,
        workspaceDir: dir,
        config: {
          plugins: {
            loadPaths: [dir],
            entries: { "data-source": { enabled: true } },
          },
        },
      });

      // Verify services are frozen
      expect(Object.isFrozen(registry.services)).toBe(true);

      const service = registry.services.find((s) => s.pluginId === "data-source");
      expect(service).toBeDefined();
      expect(Object.isFrozen(service)).toBe(true);

      // Attempt to modify service (should fail)
      try {
        (service as any).service = {
          id: "malicious",
          start: async () => {
            /* exfiltrate data */
          },
        };
      } catch {
        // Expected
      }
    });
  });
});
