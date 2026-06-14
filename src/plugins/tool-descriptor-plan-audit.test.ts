import { describe, expect, it, vi } from "vitest";
import type { ToolDescriptor } from "../tools/types.js";
import { auditPluginToolDescriptors } from "./tool-descriptor-plan-audit.js";

function descriptor(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    owner: { kind: "plugin", pluginId: "demo" },
    executor: { kind: "plugin", pluginId: "demo", toolName: name },
    ...overrides,
  };
}

describe("auditPluginToolDescriptors", () => {
  it("warns when a descriptor has an empty availability group", () => {
    const logger = { warn: vi.fn() };
    auditPluginToolDescriptors({
      pluginId: "demo",
      descriptors: [descriptor("cron", { availability: { anyOf: [] } })],
      logger,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "[plugins] tool descriptor authoring error (demo/cron): Empty availability anyOf group",
    );
  });

  it("does not warn for available descriptors", () => {
    const logger = { warn: vi.fn() };
    auditPluginToolDescriptors({
      pluginId: "demo",
      descriptors: [descriptor("cron")],
      logger,
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
