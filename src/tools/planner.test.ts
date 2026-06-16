// Verifies tool planner filtering, ordering, and unsupported-tool reporting.
import { describe, expect, it, vi } from "vitest";
import { ToolPlanContractError } from "./diagnostics.js";
import { formatToolExecutorRef } from "./execution.js";
import { buildToolPlan } from "./planner.js";
import { toToolProtocolDescriptors } from "./protocol.js";
import type { ToolDescriptor } from "./types.js";

function descriptor(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object" },
    owner: { kind: "core" },
    executor: { kind: "core", executorId: name },
    ...overrides,
  };
}

type ToolPlan = ReturnType<typeof buildToolPlan>;

function expectHiddenTool(plan: ToolPlan, index: number): ToolPlan["hidden"][number] {
  const entry = plan.hidden[index];
  if (!entry) {
    throw new Error(`Expected hidden tool at index ${index}`);
  }
  return entry;
}

describe("buildToolPlan", () => {
  it("sorts visible and hidden tools deterministically", () => {
    const plan = buildToolPlan({
      descriptors: [
        descriptor("zeta"),
        descriptor("alpha"),
        descriptor("hidden", {
          sortKey: "middle",
          availability: { kind: "env", name: "MISSING_ENV" },
        }),
      ],
      availability: { env: {} },
    });

    expect(plan.visible.map((entry) => entry.descriptor.name)).toEqual(["alpha", "zeta"]);
    expect(plan.hidden.map((entry) => entry.descriptor.name)).toEqual(["hidden"]);
    expect(expectHiddenTool(plan, 0).diagnostics.map((entry) => entry.reason)).toEqual([
      "env-missing",
    ]);
  });

  it("fails deterministically on duplicate tool names", () => {
    let error: unknown;
    try {
      buildToolPlan({
        descriptors: [descriptor("read"), descriptor("read")],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ToolPlanContractError);
    const contractError = error as ToolPlanContractError;
    expect(contractError.code).toBe("duplicate-tool-name");
    expect(contractError.toolName).toBe("read");
  });

  it("fails closed when a visible descriptor has no executor", () => {
    let error: unknown;
    try {
      buildToolPlan({
        descriptors: [descriptor("read", { executor: undefined })],
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ToolPlanContractError);
    const contractError = error as ToolPlanContractError;
    expect(contractError.code).toBe("missing-executor");
    expect(contractError.toolName).toBe("read");
  });

  it("does not require an executor for unavailable descriptors", () => {
    const plan = buildToolPlan({
      descriptors: [
        descriptor("plugin_tool", {
          executor: undefined,
          availability: { kind: "plugin-enabled", pluginId: "demo" },
        }),
      ],
      availability: { enabledPluginIds: new Set() },
    });

    expect(plan.visible).toStrictEqual([]);
    const hiddenTool = expectHiddenTool(plan, 0);
    expect(hiddenTool.descriptor.name).toBe("plugin_tool");
    expect(hiddenTool.diagnostics.map((entry) => entry.reason)).toEqual(["plugin-disabled"]);
  });

  it("hides descriptors with malformed empty allOf availability", () => {
    const plan = buildToolPlan({
      descriptors: [descriptor("malformed", { availability: { allOf: [] } })],
    });

    expect(plan.visible).toStrictEqual([]);
    const hiddenTool = expectHiddenTool(plan, 0);
    expect(hiddenTool.descriptor.name).toBe("malformed");
    expect(hiddenTool.diagnostics).toEqual([
      {
        reason: "unsupported-signal",
        message: "Empty availability allOf group",
      },
    ]);
  });

  it("warns when empty allOf group hides a tool", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildToolPlan({
        descriptors: [
          descriptor("broken-rule", { availability: { allOf: [] } }),
        ],
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0];
      expect(message).toContain('"broken-rule"');
      expect(message).toContain("Empty availability allOf group");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("warns when empty anyOf group hides a tool", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildToolPlan({
        descriptors: [
          descriptor("broken-any", { availability: { anyOf: [] } }),
        ],
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = warnSpy.mock.calls[0]?.[0];
      expect(message).toContain('"broken-any"');
      expect(message).toContain("Empty availability anyOf group");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does not warn for non-unsupported-signal diagnostics like env-missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      buildToolPlan({
        descriptors: [
          descriptor("config-gated", {
            availability: { kind: "env", name: "MISSING_VAR" },
          }),
        ],
        availability: { env: {} },
      });

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps protocol conversion separate from executor refs and model normalization", () => {
    const plan = buildToolPlan({
      descriptors: [
        descriptor("plugin_tool", {
          owner: { kind: "plugin", pluginId: "demo" },
          executor: { kind: "plugin", pluginId: "demo", toolName: "plugin_tool" },
        }),
      ],
    });

    expect(formatToolExecutorRef(plan.visible[0].executor)).toBe("plugin:demo:plugin_tool");
    expect(toToolProtocolDescriptors(plan.visible)).toEqual([
      {
        name: "plugin_tool",
        description: "plugin_tool description",
        inputSchema: { type: "object" },
      },
    ]);
  });
});
