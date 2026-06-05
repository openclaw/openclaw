// Session extension registration tests cover plugin-owned metadata snapshotting.
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { projectPluginSessionExtensionsSync } from "../host-hook-state.js";
import type { PluginJsonValue, PluginSessionExtensionRegistration } from "../host-hooks.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import { createPluginRecord } from "../status.test-helpers.js";

function diagnosticSummaries(diagnostics: readonly unknown[]) {
  return diagnostics.map((entry) => {
    const diagnostic = entry as { pluginId?: string; message?: string };
    return { pluginId: diagnostic.pluginId, message: diagnostic.message };
  });
}

describe("plugin session extension registration", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("snapshots extension metadata before session projection", () => {
    let projectReads = 0;
    let slotSchemaReads = 0;
    const slotSchema = { type: "object", properties: { state: { type: "string" } } };
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "volatile-session-extension",
        name: "Volatile Session Extension",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Workflow state",
          sessionEntrySlotKey: "approvalSnapshot",
          get sessionEntrySlotSchema() {
            slotSchemaReads += 1;
            if (slotSchemaReads > 1) {
              throw new Error("slot schema getter re-read");
            }
            return slotSchema;
          },
          get project() {
            projectReads += 1;
            if (projectReads > 1) {
              throw new Error("project getter re-read");
            }
            return ({ state }) => {
              if (!state || typeof state !== "object" || Array.isArray(state)) {
                return undefined;
              }
              return { state: (state as Record<string, PluginJsonValue>).state ?? null };
            };
          },
        } as PluginSessionExtensionRegistration);
      },
    });
    setActivePluginRegistry(registry.registry);

    expect(registry.registry.sessionExtensions?.[0]?.extension.sessionEntrySlotSchema).toEqual(
      slotSchema,
    );
    expect(projectReads).toBe(1);
    expect(slotSchemaReads).toBe(1);
    expect(
      projectPluginSessionExtensionsSync({
        sessionKey: "agent:main:main",
        entry: {
          sessionId: "session-1",
          updatedAt: 1,
          pluginExtensions: {
            "volatile-session-extension": {
              workflow: { state: "waiting" },
            },
          },
        },
      }),
    ).toEqual([
      {
        pluginId: "volatile-session-extension",
        namespace: "workflow",
        value: { state: "waiting" },
      },
    ]);
    expect(projectReads).toBe(1);
    expect(slotSchemaReads).toBe(1);
  });

  it("rejects non-JSON session extension slot schemas", () => {
    const { config, registry } = createPluginRegistryFixture();
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "bad-session-extension-schema",
        name: "Bad Session Extension Schema",
      }),
      register(api) {
        api.registerSessionExtension({
          namespace: "workflow",
          description: "Workflow state",
          sessionEntrySlotKey: "approvalSnapshot",
          sessionEntrySlotSchema: new Date(0) as never,
        });
      },
    });

    expect(registry.registry.sessionExtensions ?? []).toHaveLength(0);
    expect(diagnosticSummaries(registry.registry.diagnostics)).toEqual([
      {
        pluginId: "bad-session-extension-schema",
        message: "session extension slot schema must be JSON-compatible: workflow",
      },
    ]);
  });
});
