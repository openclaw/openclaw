import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeToolSchemaDiagnostic } from "./tool-schema-projection.js";
import type { AnyAgentTool } from "./tools/common.js";

const { emitTrustedDiagnosticEventMock, warnMock } = vi.hoisted(() => ({
  emitTrustedDiagnosticEventMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock("../infra/diagnostic-events.js", () => ({
  emitTrustedDiagnosticEvent: emitTrustedDiagnosticEventMock,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    warn: warnMock,
  }),
}));

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: (tool: { name?: string }) =>
    tool.name === "mockplugin_lookup" ? { pluginId: "mockplugin" } : undefined,
}));

import {
  collectReadableQuarantinedRuntimeToolNames,
  logRuntimeToolSchemaQuarantine,
} from "./tool-schema-quarantine.js";

describe("logRuntimeToolSchemaQuarantine", () => {
  beforeEach(() => {
    emitTrustedDiagnosticEventMock.mockClear();
    warnMock.mockClear();
  });

  it("logs unreadable tool rows without re-reading them", () => {
    const healthy = {
      name: "mockplugin_lookup",
      parameters: { type: "object", properties: {} },
    } as unknown as AnyAgentTool;
    const tools = [undefined, healthy] as unknown[];
    Object.defineProperty(tools, "0", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin tool row is unreadable");
      },
    });
    const diagnostics: RuntimeToolSchemaDiagnostic[] = [
      {
        toolName: "tool[0]",
        toolIndex: 0,
        violations: ["tool[0] is unreadable"],
      },
      {
        toolName: "mockplugin_lookup",
        toolIndex: 1,
        violations: ['mockplugin_lookup.parameters.type must be "object"'],
      },
    ];

    expect(() =>
      logRuntimeToolSchemaQuarantine({
        diagnostics,
        tools: tools as unknown as AnyAgentTool[],
        runId: "run-fuzzplugin-quarantine",
        sessionKey: "session-fuzzplugin",
      }),
    ).not.toThrow();

    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.execution.blocked",
        runId: "run-fuzzplugin-quarantine",
        sessionKey: "session-fuzzplugin",
        toolName: "tool[0]",
        toolSource: "core",
      }),
    );
    expect(emitTrustedDiagnosticEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "tool.execution.blocked",
        toolName: "mockplugin_lookup",
        toolSource: "plugin",
        toolOwner: "mockplugin",
      }),
    );
    expect(String(warnMock.mock.calls[0]?.[0])).toContain("tool[0]: tool[0] is unreadable");
  });
});

describe("collectReadableQuarantinedRuntimeToolNames", () => {
  it("keeps readable quarantined names and ignores unreadable fallback names", () => {
    const unreadableName: Record<string, unknown> = {
      parameters: { type: "object", properties: {} },
    };
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin name is unreadable");
      },
    });
    const badParameters = {
      name: "fuzzplugin_move_angles",
      parameters: {},
    };

    expect(
      collectReadableQuarantinedRuntimeToolNames({
        tools: [unreadableName, badParameters] as never,
        diagnostics: [
          {
            toolName: "tool[0]",
            toolIndex: 0,
            violations: ["tool[0].name is unreadable"],
          },
          {
            toolName: "fuzzplugin_move_angles",
            toolIndex: 1,
            violations: ["fuzzplugin_move_angles.parameters is not JSON-serializable"],
          },
        ],
      }),
    ).toEqual(["fuzzplugin_move_angles"]);
  });
});
