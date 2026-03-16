import { expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";

export function installChannelPluginContractSuite(params: {
  plugin: Pick<ChannelPlugin, "id" | "meta" | "capabilities" | "config">;
}) {
  it("satisfies the base channel plugin contract", () => {
    const { plugin } = params;

    expect(typeof plugin.id).toBe("string");
    expect(plugin.id.trim()).not.toBe("");

    expect(plugin.meta.id).toBe(plugin.id);
    expect(plugin.meta.label.trim()).not.toBe("");
    expect(plugin.meta.selectionLabel.trim()).not.toBe("");
    expect(plugin.meta.docsPath).toMatch(/^\/channels\//);
    expect(plugin.meta.blurb.trim()).not.toBe("");

    expect(plugin.capabilities.chatTypes.length).toBeGreaterThan(0);

    expect(typeof plugin.config.listAccountIds).toBe("function");
    expect(typeof plugin.config.resolveAccount).toBe("function");
  });
}
