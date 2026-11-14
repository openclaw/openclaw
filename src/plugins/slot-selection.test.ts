import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";

function enable(entry: Record<string, unknown>, pluginId = "memory-sidecar") {
  const metadata = {
    plugins: [{ id: pluginId, kind: "memory", origin: "global" }],
  } as unknown as PluginMetadataSnapshot;
  // Policy keys are lowercase; the manifest id keeps the author's casing.
  const config = {
    plugins: { slots: { memory: "memory-core" }, entries: { [pluginId.toLowerCase()]: entry } },
  } as OpenClawConfig;
  return applySlotSelectionForPlugin(config, pluginId, metadata);
}

describe("applySlotSelectionForPlugin", () => {
  it("keeps the memory slot when the operator approved the plugin as a sidecar", async () => {
    const next = await enable({ enabled: true, memory: { sidecar: true } });
    expect(next.plugins?.slots?.memory).toBe("memory-core");
  });

  it("reads the sidecar flag from the lowercase entry of a mixed-case manifest id", async () => {
    const next = await enable({ enabled: true, memory: { sidecar: true } }, "MiXeD-memory");
    expect(next.plugins?.slots?.memory).toBe("memory-core");
  });

  it("moves the memory slot to an enabled memory plugin otherwise", async () => {
    const next = await enable({ enabled: true });
    expect(next.plugins?.slots?.memory).toBe("memory-sidecar");
  });
});
