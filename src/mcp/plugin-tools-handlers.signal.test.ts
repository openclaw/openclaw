import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

function buildSignalProbeTool(): {
  tool: AnyAgentTool;
  observed: { signalDefined: boolean; abortObserved: boolean; signalAbortedAtEnd: boolean };
} {
  const observed = {
    signalDefined: false,
    abortObserved: false,
    signalAbortedAtEnd: false,
  };
  const tool = {
    name: "probe-cancel",
    description: "echoes whether the host AbortSignal was received",
    parameters: { type: "object", properties: {} },
    execute: async (
      _toolCallId: string,
      _params: unknown,
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
      observed.signalDefined = signal !== undefined;
      if (signal) {
        const onAbort = () => {
          observed.abortObserved = true;
        };
        signal.addEventListener("abort", onAbort, { once: true });
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
          setTimeout(resolve, 50);
        });
        signal.removeEventListener("abort", onAbort);
        observed.signalAbortedAtEnd = signal.aborted;
      }
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as AnyAgentTool;
  return { tool, observed };
}

describe("plugin tools MCP handlers forward AbortSignal (#82424)", () => {
  it("invokes tool.execute with a defined AbortSignal", async () => {
    const { tool, observed } = buildSignalProbeTool();
    const handlers = createPluginToolsMcpHandlers([tool]);

    const controller = new AbortController();
    await handlers.callTool({ name: "probe-cancel", arguments: {} }, { signal: controller.signal });

    expect(observed.signalDefined).toBe(true);
  });

  it("propagates abort() to the in-flight tool", async () => {
    const { tool, observed } = buildSignalProbeTool();
    const handlers = createPluginToolsMcpHandlers([tool]);

    const controller = new AbortController();
    const pending = handlers.callTool(
      { name: "probe-cancel", arguments: {} },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    await pending;

    expect(observed.abortObserved).toBe(true);
    expect(observed.signalAbortedAtEnd).toBe(true);
  });

  it("works without a signal (backward compatibility)", async () => {
    const { tool, observed } = buildSignalProbeTool();
    const handlers = createPluginToolsMcpHandlers([tool]);

    await handlers.callTool({ name: "probe-cancel", arguments: {} });

    expect(observed.signalDefined).toBe(false);
  });
});
