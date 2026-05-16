import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createToolsMcpServer } from "./tools-stdio-server.js";

describe("plugin-tools handler forwards host cancellation to tool.execute", () => {
  it("aborts in-flight tool.execute when client cancels the request", async () => {
    let observedSignal: AbortSignal | undefined;
    let abortFired = false;

    const probeTool = {
      name: "probe-cancel",
      description: "regression probe for SOL-0010 signal propagation",
      parameters: {},
      ownerOnly: false,
      execute: async (_toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        observedSignal = signal;
        await new Promise<void>((resolve, reject) => {
          if (!signal) {
            // Without the fix the signal is undefined; surface that explicitly
            // so the test fails fast instead of hanging.
            reject(new Error("tool.execute did not receive AbortSignal"));
            return;
          }
          if (signal.aborted) {
            abortFired = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              abortFired = true;
              resolve();
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "done" }] };
      },
    } as unknown as AnyAgentTool;

    const server = createToolsMcpServer({ name: "test", tools: [probeTool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const controller = new AbortController();
      const callPromise = client.callTool({ name: "probe-cancel", arguments: {} }, undefined, {
        signal: controller.signal,
      });

      // Let the server handler invoke tool.execute and register the abort
      // listener before we trip the controller.
      await new Promise((r) => setTimeout(r, 20));
      expect(observedSignal, "handler should receive AbortSignal via extra.signal").toBeInstanceOf(
        AbortSignal,
      );
      expect(observedSignal?.aborted).toBe(false);

      controller.abort();

      await expect(callPromise).rejects.toBeDefined();
      expect(abortFired, "tool.execute observed signal.abort event").toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
