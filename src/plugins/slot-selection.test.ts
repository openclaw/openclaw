import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";

const metadata = {
  plugins: [{ id: "memory-sidecar", kind: "memory", origin: "global" }],
} as unknown as PluginMetadataSnapshot;

function enable(entry: Record<string, unknown>) {
  const config = {
    plugins: { slots: { memory: "memory-core" }, entries: { "memory-sidecar": entry } },
  } as OpenClawConfig;
  return applySlotSelectionForPlugin(config, "memory-sidecar", metadata);
}

describe("applySlotSelectionForPlugin", () => {
  it("keeps the memory slot when the operator approved the plugin as a sidecar", async () => {
    const next = await enable({ enabled: true, memory: { sidecar: true } });
    expect(next.plugins?.slots?.memory).toBe("memory-core");
  });

  it("moves the memory slot to an enabled memory plugin otherwise", async () => {
    const next = await enable({ enabled: true });
    expect(next.plugins?.slots?.memory).toBe("memory-sidecar");
  });
});
