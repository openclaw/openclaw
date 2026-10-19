import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import {
  registerContextEngineInRegistry,
  registerContextEngineForOwner,
} from "../../../context-engine/registry.js";
import type { ContextEngineHostCapability } from "../../../context-engine/types.js";
import { acquirePluginRegistryForInspection } from "../../../plugins/loader.js";
import { PluginInstance } from "../../../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../../../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../../../plugins/registry-inspection.test-support.js";
import { createPluginRecord } from "../../../plugins/status.test-helpers.js";
import {
  collectContextEngineHostCompatibilityWarnings,
  maybeRepairContextEngineHostCompatibility,
} from "./context-engine-host-compat.js";

vi.mock("../../../agents/cli-backends.js", () => ({
  resolveCliBackendConfig: vi.fn((runtimeId: string) => ({ id: runtimeId })),
}));

vi.mock("../../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: vi.fn(
    (params: { config: OpenClawConfig; modelId: string; provider: string }) => ({
      runtime:
        params.config.agents?.defaults?.models?.[`${params.provider}/${params.modelId}`]
          ?.agentRuntime?.id ?? "openclaw",
    }),
  ),
}));

vi.mock("../../../agents/harness/registry.js", () => ({
  getRegisteredAgentHarness: vi.fn(() => undefined),
}));

// mock-isolation: Register synthetic engines without initializing live context-engine plugins.
vi.mock("../../../context-engine/init.js", () => ({ ensureContextEnginesInitialized: vi.fn() }));

// mock-isolation: Control inspection leases without loading installed plugins.
vi.mock("../../../plugins/loader.js", () => ({ acquirePluginRegistryForInspection: vi.fn() }));

let engineCounter = 0;

function uniqueEngineId(): string {
  engineCounter += 1;
  return `doctor-host-compat-${engineCounter}`;
}

async function registerEngine(
  requiredCapabilities: ContextEngineHostCapability[],
): Promise<string> {
  const id = uniqueEngineId();
  class TestEngine extends LegacyContextEngine {
    override readonly info = {
      id,
      name: "Doctor Host Compat",
      hostRequirements:
        requiredCapabilities.length > 0
          ? {
              "agent-run": {
                requiredCapabilities,
                unsupportedMessage: "Use a compatible runtime or switch to legacy.",
              },
            }
          : undefined,
    };
  }
  await registerContextEngineForOwner(id, () => new TestEngine(), `doctor-test-owner-${id}`, {
    allowSameOwnerRefresh: true,
  });
  return id;
}

function configWithEngine(engineId: string, cfg: OpenClawConfig = {}): OpenClawConfig {
  return {
    ...cfg,
    plugins: { ...cfg.plugins, slots: { ...cfg.plugins?.slots, contextEngine: engineId } },
  };
}

function doctorParams(cfg: OpenClawConfig) {
  return { cfg, doctorFixCommand: "openclaw doctor --fix" };
}

describe("doctor context-engine host compatibility", () => {
  it.each([false, true])(
    "settles context engine custody before returning (disposal fails: %s)",
    async (disposalFails) => {
      const id = uniqueEngineId();
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id });
      registry.plugins.push(record);
      const instance = new PluginInstance(id, { record, registry });
      const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
      resources.attach(registry);
      const retired = vi.fn();
      resources.register("fixture", { id: "doctor-resource", dispose: retired });
      const disposalStarted = createDeferred();
      const disposalGate = createDeferred();
      class DoctorEngine extends LegacyContextEngine {
        override readonly info = {
          id,
          name: "Doctor custody fixture",
          hostRequirements: undefined,
        };
        async dispose() {
          expect(retired).not.toHaveBeenCalled();
          disposalStarted.resolve();
          await disposalGate.promise;
          if (disposalFails) {
            throw new Error("doctor engine disposal failed");
          }
        }
      }
      registerContextEngineInRegistry(
        registry,
        id,
        instance.wrap(() => new DoctorEngine()),
        `plugin:${id}`,
      );
      vi.mocked(acquirePluginRegistryForInspection).mockResolvedValue({
        registry,
        release: () => resources.release(),
      });
      const pending = collectContextEngineHostCompatibilityWarnings(
        doctorParams(configWithEngine(id)),
      );
      try {
        expect(
          await Promise.race([
            disposalStarted.promise.then(() => "disposing"),
            pending.then(() => "returned"),
          ]),
        ).toBe("disposing");
        expect(retired).not.toHaveBeenCalled();
        disposalGate.resolve();
        const warnings = await pending;
        if (disposalFails) {
          expect(warnings.join("\n")).toContain("doctor engine disposal failed");
        } else {
          expect(warnings).toEqual([]);
        }
        expect(retired).toHaveBeenCalledOnce();
      } finally {
        disposalGate.resolve();
        await pending.catch(() => {});
        await resources.release();
        await instance.dispose();
        vi.mocked(acquirePluginRegistryForInspection).mockReset();
      }
    },
  );

  it.each([true, false])(
    "reports offline inspection availability without activating or repairing an engine (discovered=%s)",
    async (discovered) => {
      const id = uniqueEngineId();
      const factory = vi.fn(() => {
        throw new Error("Doctor must not initialize an engine to inspect its metadata");
      });
      const registry = createEmptyPluginRegistry();
      if (discovered) {
        registry.contextEngines.set(id, {
          factory,
          owner: `plugin:${id}`,
          lifecycle: "readOnlyDiscovery",
        });
      }
      vi.mocked(acquirePluginRegistryForInspection).mockImplementation(async () => ({
        registry,
        release: async () => undefined,
      }));
      const cfg = configWithEngine(id);
      const params = doctorParams(cfg);
      const warnings = await collectContextEngineHostCompatibilityWarnings(params);
      expect(warnings.join("\n")).toContain(
        discovered
          ? "registered for read-only discovery; offline host compatibility inspection is unavailable"
          : "because it is not registered",
      );
      const repair = await maybeRepairContextEngineHostCompatibility(params);
      expect(repair).toEqual({ config: cfg, changes: [], warnings });
      expect(repair.config).toBe(cfg);
      expect(factory).not.toHaveBeenCalled();
    },
  );

  it("uses the system agent when inspecting an explicit multi-agent roster", async () => {
    const engineId = await registerEngine([]);
    const warnings = await collectContextEngineHostCompatibilityWarnings(
      doctorParams(
        configWithEngine(engineId, {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" }, model: "anthropic/claude-sonnet-4-6" },
            entries: {
              main: { agentDir: "/tmp/openclaw-doctor-host-compat" },
              helper: {},
              third: {},
            },
          },
        }),
      ),
    );

    expect(warnings).toEqual([]);
  });

  it.each([false, true])("repairs only globally incompatible hosts (mixed=%s)", async (mixed) => {
    const engineId = await registerEngine(["assemble-before-prompt"]);
    const cfg = configWithEngine(engineId, {
      ...(!mixed ? { plugins: { slots: { memory: "custom-memory" } } } : {}),
      agents: {
        defaults: {
          ...(!mixed ? { model: "anthropic/claude-sonnet-4-6" } : {}),
          models: {
            "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
            ...(mixed ? { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } : {}),
          },
        },
      },
    });
    const params = doctorParams(cfg);
    const warnings = mixed ? [] : await collectContextEngineHostCompatibilityWarnings(params);
    const result = await maybeRepairContextEngineHostCompatibility(params);
    if (mixed) {
      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
      expect(result.warnings?.join("\n")).toContain(
        "Some configured runtimes support context engine",
      );
    } else {
      expect(warnings.join("\n")).toContain(
        'remove the plugins.slots.contextEngine override and restore the default "legacy"',
      );
      expect(result.config.plugins?.slots).toEqual({ memory: "custom-memory" });
      expect(result.changes).toEqual([
        `Reset plugins.slots.contextEngine to the default "legacy" because context engine "${engineId}" is incompatible with every configured agent-run host.`,
      ]);
    }
  });
});
