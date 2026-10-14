import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  registerContextEngineInRegistry,
  resolveContextEngine,
  resolveContextEngineTranscriptByteLimit,
} from "./registry.js";

it("retains the admitted byte budget across separate core and SDK module instances", async () => {
  const registry = createEmptyPluginRegistry();
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  await withPluginRuntimeRegistryScope(registry, async () => {
    const engine = await resolveContextEngine({
      agents: { defaults: { compaction: { maxActiveTranscriptBytes: "32kb" } } },
    });
    try {
      expect(resolveContextEngineTranscriptByteLimit(engine)).toBe(32_768);
      // Built plugin SDK artifacts load their own copy of the registry module.
      vi.resetModules();
      const sdkRegistry = await import("./registry.js");
      expect(sdkRegistry.resolveContextEngineTranscriptByteLimit(engine)).toBe(32_768);
    } finally {
      await engine.dispose?.();
    }
  });
});
