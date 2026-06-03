import { afterEach, describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { logRuntimeToolSchemaQuarantine } from "./tool-schema-quarantine.js";
import type { AnyAgentTool } from "./tools/common.js";

describe("runtime tool schema quarantine logging", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("does not re-read unreadable tool entries while logging diagnostics", () => {
    const tools = new Proxy([] as AnyAgentTool[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() =>
      logRuntimeToolSchemaQuarantine({
        diagnostics: [
          {
            toolName: "tool[0]",
            toolIndex: 0,
            violations: ["tool[0] is unreadable"],
          },
        ],
        tools,
        runId: "run-fuzzplugin-unreadable-tool",
      }),
    ).not.toThrow();
  });

  it("sanitizes unsupported schema diagnostics before logging trusted quarantine events", async () => {
    const capture = createWarnLogCapture("tool-schema-quarantine");
    const blockedEvents: Extract<DiagnosticEventPayload, { type: "tool.execution.blocked" }>[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "tool.execution.blocked") {
        blockedEvents.push(event);
      }
    });
    try {
      const toolName = "bad_tool\n\u001b]0;pwned\u0007";

      logRuntimeToolSchemaQuarantine({
        diagnostics: [
          {
            toolName,
            toolIndex: 0,
            violations: [`${toolName}.parameters.type must be "object"`],
          },
        ],
        tools: [
          {
            name: toolName,
            parameters: { type: "array", items: { type: "number" } },
            execute: async () => ({ text: "never" }),
          } as unknown as AnyAgentTool,
        ],
        runId: "run-fuzzplugin-terminal-control",
      });

      await waitForDiagnosticEventsDrained();
      const warning = await capture.findText("quarantined 1 unsupported tool schema");
      expect(warning).toBeDefined();
      expect(warning).not.toContain("\n");
      expect(warning).not.toContain("\u001b");
      expect(warning).not.toContain("\u0007");
      expect(warning).toContain("bad_tool");
      expect(warning).toContain('bad_tool.parameters.type must be "object"');
      expect(blockedEvents).toEqual([
        expect.objectContaining({
          toolName: "bad_tool",
          deniedReason: "unsupported_tool_schema",
          reason: 'bad_tool.parameters.type must be "object"',
        }),
      ]);
    } finally {
      unsubscribe();
      capture.cleanup();
    }
  });
});
