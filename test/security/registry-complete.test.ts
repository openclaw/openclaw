/**
 * Complete integration test for registry security
 * Tests the full lifecycle: loading -> registration -> finalization -> tampering attempts
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginRegistry } from "../../src/plugins/registry.js";
import { loadOpenClawPlugins } from "../../src/plugins/loader.js";

type TempPlugin = { dir: string; file: string; id: string };

const tempDirs: string[] = [];
const EMPTY_PLUGIN_SCHEMA = { type: "object", additionalProperties: false, properties: {} };

function makeTempDir() {
  const dir = path.join(os.tmpdir(), `openclaw-registry-${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writePlugin(params: {
  id: string;
  body: string;
  dir?: string;
  filename?: string;
  schema?: Record<string, unknown>;
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
        configSchema: params.schema ?? EMPTY_PLUGIN_SCHEMA,
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

describe("Complete Registry Security Integration", () => {
  it("should complete full lifecycle: load -> register -> finalize -> block tampering", () => {
    const dir = makeTempDir();

    // Create multiple plugins
    writePlugin({
      id: "plugin-alpha",
      body: `
        export default {
          id: "plugin-alpha",
          name: "Alpha Plugin",
          register(api) {
            api.registerTool(() => ({
              name: "alpha-tool",
              type: "function",
              function: {
                name: "alpha-tool",
                description: "Alpha tool",
                parameters: { type: "object", properties: {} }
              },
              handler: () => ({ result: "alpha" })
            }));
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
          name: "Beta Plugin",
          register(api) {
            api.registerTool(() => ({
              name: "beta-tool",
              type: "function",
              function: {
                name: "beta-tool",
                description: "Beta tool",
                parameters: { type: "object", properties: {} }
              },
              handler: () => ({ result: "beta" })
            }));
          }
        };
      `,
      dir,
      filename: "beta.js",
    });

    // Load plugins
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

    // Verify plugins loaded
    expect(registry.plugins.length).toBeGreaterThanOrEqual(2);
    const alpha = registry.plugins.find((p) => p.id === "plugin-alpha");
    const beta = registry.plugins.find((p) => p.id === "plugin-beta");
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();

    // Verify registry is frozen after loading
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.plugins)).toBe(true);
    expect(Object.isFrozen(registry.tools)).toBe(true);

    // Verify plugin records are frozen
    expect(Object.isFrozen(alpha)).toBe(true);
    expect(Object.isFrozen(beta)).toBe(true);

    // Test 1: Cannot add new plugins to frozen registry
    const pluginsCountBefore = registry.plugins.length;
    expect(() => {
      (registry.plugins as any).push({
        id: "malicious",
        name: "Malicious Plugin",
      });
    }).toThrow();
    expect(registry.plugins.length).toBe(pluginsCountBefore);

    // Test 2: Cannot modify plugin properties
    const alphaNameBefore = alpha!.name;
    try {
      (alpha as any).name = "Hacked Alpha";
    } catch {
      // Expected in strict mode
    }
    expect(alpha!.name).toBe(alphaNameBefore);

    // Test 3: Cannot modify plugin arrays
    const alphaToolsBefore = alpha!.toolNames.length;
    expect(() => {
      alpha!.toolNames.push("malicious-tool");
    }).toThrow();
    expect(alpha!.toolNames.length).toBe(alphaToolsBefore);

    // Test 4: Cannot modify tool registrations
    const alphaTool = registry.tools.find((t) => t.pluginId === "plugin-alpha");
    expect(alphaTool).toBeDefined();
    expect(Object.isFrozen(alphaTool)).toBe(true);

    const originalFactory = alphaTool!.factory;
    try {
      (alphaTool as any).factory = () => ({ name: "hacked", type: "function" });
    } catch {
      // Expected
    }
    expect(alphaTool!.factory).toBe(originalFactory);

    // Test 5: Cannot modify tools array
    const toolsCountBefore = registry.tools.length;
    expect(() => {
      (registry.tools as any).push({
        pluginId: "malicious",
        factory: () => null,
        names: ["malicious"],
        optional: false,
        source: "/malicious.js",
      });
    }).toThrow();
    expect(registry.tools.length).toBe(toolsCountBefore);
  });

  it("should block late registration attempts", () => {
    const dir = makeTempDir();

    // Track if API was captured
    let capturedApiId: string | null = null;

    writePlugin({
      id: "late-register",
      body: `
        export default {
          id: "late-register",
          register(api) {
            // Store API reference globally (bad practice)
            globalThis.__testCapturedApi = api;
            globalThis.__testCapturedApiId = api.id;
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
          entries: { "late-register": { enabled: true } },
        },
      },
    });

    // Try to use captured API after finalization
    const capturedApi = (globalThis as any).__testCapturedApi;
    capturedApiId = (globalThis as any).__testCapturedApiId;

    expect(capturedApi).toBeDefined();
    expect(capturedApiId).toBe("late-register");

    // Registry should be finalized
    expect(Object.isFrozen(registry)).toBe(true);

    // Attempt late registration
    const toolsCountBefore = registry.tools.length;
    const diagnosticsCountBefore = registry.diagnostics.length;

    capturedApi.registerTool(() => ({
      name: "late-tool",
      type: "function",
    }));

    // Tool should not be added (or if added, array is frozen so push will fail)
    // The diagnostic array is also frozen, so we can't check for new diagnostics
    expect(registry.tools.length).toBe(toolsCountBefore);

    // Cleanup
    delete (globalThis as any).__testCapturedApi;
    delete (globalThis as any).__testCapturedApiId;
  });

  it("should maintain security across multiple load/finalize cycles", () => {
    const dir1 = makeTempDir();
    const dir2 = makeTempDir();

    writePlugin({
      id: "cycle-1",
      body: `
        export default {
          id: "cycle-1",
          register(api) {
            api.registerTool(() => ({ name: "cycle-1-tool", type: "function" }));
          }
        };
      `,
      dir: dir1,
    });

    writePlugin({
      id: "cycle-2",
      body: `
        export default {
          id: "cycle-2",
          register(api) {
            api.registerTool(() => ({ name: "cycle-2-tool", type: "function" }));
          }
        };
      `,
      dir: dir2,
    });

    // First load
    const registry1 = loadOpenClawPlugins({
      cache: false,
      workspaceDir: dir1,
      config: {
        plugins: {
          loadPaths: [dir1],
          entries: { "cycle-1": { enabled: true } },
        },
      },
    });

    expect(Object.isFrozen(registry1)).toBe(true);
    const cycle1Plugin = registry1.plugins.find((p) => p.id === "cycle-1");
    expect(cycle1Plugin).toBeDefined();
    expect(Object.isFrozen(cycle1Plugin)).toBe(true);

    // Second load (different config)
    const registry2 = loadOpenClawPlugins({
      cache: false,
      workspaceDir: dir2,
      config: {
        plugins: {
          loadPaths: [dir2],
          entries: { "cycle-2": { enabled: true } },
        },
      },
    });

    expect(Object.isFrozen(registry2)).toBe(true);
    const cycle2Plugin = registry2.plugins.find((p) => p.id === "cycle-2");
    expect(cycle2Plugin).toBeDefined();
    expect(Object.isFrozen(cycle2Plugin)).toBe(true);

    // Both registries should be independently frozen
    expect(registry1).not.toBe(registry2);
    expect(Object.isFrozen(registry1)).toBe(true);
    expect(Object.isFrozen(registry2)).toBe(true);
  });

  it("should prevent modification of gateway handlers", () => {
    const dir = makeTempDir();

    writePlugin({
      id: "gateway-plugin",
      body: `
        export default {
          id: "gateway-plugin",
          register(api) {
            api.registerGatewayMethod("custom-method", async (req) => {
              return { success: true };
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
          entries: { "gateway-plugin": { enabled: true } },
        },
      },
    });

    // Verify gateway handler registered
    expect(registry.gatewayHandlers["custom-method"]).toBeDefined();
    expect(Object.isFrozen(registry.gatewayHandlers)).toBe(true);

    const originalHandler = registry.gatewayHandlers["custom-method"];

    // Attempt to replace handler
    try {
      registry.gatewayHandlers["custom-method"] = async () => ({
        success: false,
        hacked: true,
      });
    } catch {
      // Expected
    }

    // Handler should be unchanged
    expect(registry.gatewayHandlers["custom-method"]).toBe(originalHandler);
  });

  it("should freeze all registration types comprehensively", () => {
    const dir = makeTempDir();

    writePlugin({
      id: "comprehensive",
      body: `
        export default {
          id: "comprehensive",
          register(api) {
            api.registerTool(() => ({ name: "comp-tool", type: "function" }));
            api.registerService({
              id: "comp-service",
              start: async () => {},
              stop: async () => {}
            });
            api.registerCommand({
              name: "comp-cmd",
              description: "Test command",
              handler: () => ({ text: "test" })
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
          entries: { comprehensive: { enabled: true } },
        },
      },
    });

    // All registration arrays should be frozen
    const arrays = [
      "plugins",
      "tools",
      "hooks",
      "typedHooks",
      "channels",
      "providers",
      "httpHandlers",
      "httpRoutes",
      "cliRegistrars",
      "services",
      "commands",
      "diagnostics",
    ] as const;

    for (const arrayName of arrays) {
      expect(Object.isFrozen(registry[arrayName]), `registry.${arrayName} should be frozen`).toBe(
        true,
      );
    }

    // Verify objects are frozen
    expect(Object.isFrozen(registry.gatewayHandlers)).toBe(true);
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("should demonstrate complete attack scenario failure", () => {
    const dir = makeTempDir();

    // Victim plugin with "sensitive" data
    writePlugin({
      id: "payment-processor",
      body: `
        const API_KEY = "secret-payment-key-12345";

        export default {
          id: "payment-processor",
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
                // Use secret internally
                return { success: true, transactionId: "tx_12345" };
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
          entries: { "payment-processor": { enabled: true } },
        },
      },
    });

    // ATTACK SCENARIO: Try to compromise payment processor

    // Attack 1: Try to find and modify the payment tool
    const paymentTool = registry.tools.find((t) => t.pluginId === "payment-processor");
    expect(paymentTool).toBeDefined();
    expect(Object.isFrozen(paymentTool)).toBe(true);

    const originalFactory = paymentTool!.factory;
    try {
      (paymentTool as any).factory = () => ({
        name: "process-payment",
        type: "function",
        handler: () => ({ success: false, stolen: true }),
      });
    } catch {
      // Expected
    }
    expect(paymentTool!.factory).toBe(originalFactory);

    // Attack 2: Try to access plugin internals
    const paymentPlugin = registry.plugins.find((p) => p.id === "payment-processor");
    expect(paymentPlugin).toBeDefined();
    expect(Object.isFrozen(paymentPlugin)).toBe(true);

    // Can't modify plugin record
    try {
      (paymentPlugin as any).name = "Hacked Payment";
    } catch {
      // Expected
    }
    expect(paymentPlugin!.name).toBe("payment-processor");

    // Attack 3: Try to inject malicious gateway handler
    const gatewayCountBefore = Object.keys(registry.gatewayHandlers).length;
    try {
      registry.gatewayHandlers["admin/steal-data"] = async () => ({
        allPayments: "stolen",
      });
    } catch {
      // Expected
    }
    const gatewayCountAfter = Object.keys(registry.gatewayHandlers).length;
    expect(gatewayCountAfter).toBe(gatewayCountBefore);

    // ALL ATTACKS BLOCKED - Security layer successful!
  });
});
