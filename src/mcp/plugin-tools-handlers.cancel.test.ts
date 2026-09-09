// Plugin MCP cancellation tests cover cancellation of in-flight plugin tool calls.
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { consumeTrackedToolExecutionStarted } from "../agents/agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createToolsMcpServer } from "./tools-stdio-server.js";

describe("plugin tools MCP cancellation", () => {
  it("forwards host cancellation to tool.execute", async () => {
    let resolveObservedSignal: (signal: AbortSignal | undefined) => void;
    const observedSignal = new Promise<AbortSignal | undefined>((resolve) => {
      resolveObservedSignal = resolve;
    });
    let abortObserved = false;
    let observedToolCallId: string | undefined;

    const tool = {
      name: "probe_cancel",
      description: "Probe cancellation forwarding",
      parameters: { type: "object", properties: {} },
      execute: async (toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        observedToolCallId = toolCallId;
        resolveObservedSignal(signal);
        await new Promise<void>((resolve, reject) => {
          if (!signal) {
            reject(new Error("tool.execute did not receive AbortSignal"));
            return;
          }
          if (signal.aborted) {
            abortObserved = true;
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              abortObserved = true;
              resolve();
            },
            { once: true },
          );
        });
        return { content: [{ type: "text", text: "done" }] };
      },
    } as unknown as AnyAgentTool;

    const server = createToolsMcpServer({ name: "test", tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const controller = new AbortController();
      const callPromise = client.callTool({ name: "probe_cancel", arguments: {} }, undefined, {
        signal: controller.signal,
      });
      const signal = await observedSignal;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal?.aborted).toBe(false);

      controller.abort();

      await expect(callPromise).rejects.toBeDefined();
      expect(abortObserved).toBe(true);
      expect(observedToolCallId).toBeDefined();
      if (!observedToolCallId) {
        throw new Error("tool.execute did not receive a call id");
      }
      expect(consumeTrackedToolExecutionStarted(observedToolCallId)).toBeUndefined();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each(["handler", "descendant"] as const)(
    "joins native %s work before close releases its database and permits reconnect",
    async (mode) => {
      let database = new DatabaseSync(":memory:");
      const started = createDeferred();
      const finish = createDeferred();
      const reads: unknown[] = [];
      let queryError: unknown;
      let signal: AbortSignal | undefined;
      let pendingWork: ReturnType<AnyAgentTool["execute"]> | undefined;
      const runNativeWork = async (): ReturnType<AnyAgentTool["execute"]> => {
        started.resolve();
        await finish.promise;
        try {
          reads.push(database.prepare("SELECT 42 AS value").get());
        } catch (error) {
          queryError = error;
          throw error;
        }
        return { content: [{ type: "text", text: "done" }], details: {} };
      };
      const tool: AnyAgentTool = {
        name: "native_cleanup",
        label: "Native cleanup",
        description: "Keeps accepted database work alive through cancellation",
        parameters: Type.Object({}),
        execute: async (_id, _params, requestSignal) => {
          signal = requestSignal;
          pendingWork = mode === "handler" ? runNativeWork() : trackAsyncWork(runNativeWork);
          if (mode === "handler") {
            return await pendingWork;
          }
          void pendingWork.catch(() => {});
          return { content: [{ type: "text", text: "accepted" }], details: {} };
        },
      };
      const server = createToolsMcpServer({ name: "native-drain", tools: [tool] });
      const clients: Client[] = [];
      const connect = async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client(
          { name: "native-client", version: "0.0.0" },
          { capabilities: {} },
        );
        clients.push(client);
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        return client;
      };
      let closing: Promise<void> | undefined;
      let siblingClose: Promise<void> | undefined;
      try {
        const client = await connect();
        const call = client.callTool({ name: tool.name, arguments: {} });
        const callResult = call.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        await Promise.race([
          started.promise,
          call.then(() => {
            throw new Error("Tool completed before native work started");
          }),
        ]);
        if (mode === "descendant") {
          expect(await callResult).toMatchObject({
            result: { content: [{ type: "text", text: "accepted" }] },
          });
        }
        let transportClosed = false;
        let released = false;
        let siblingSettled = false;
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Server exposes callback properties, not EventTarget.
        server.onclose = () => {
          transportClosed = true;
        };
        closing = server.close().then(() => {
          database.close();
          released = true;
        });
        siblingClose = server.close().then(() => {
          siblingSettled = true;
        });
        await nextTurn();
        expect(transportClosed).toBe(true);
        if (mode === "handler") {
          expect(signal?.aborted).toBe(true);
          expect(await callResult).toHaveProperty("error");
        }
        expect.soft(released).toBe(false);
        expect.soft(siblingSettled).toBe(false);
        expect.soft(database.isOpen).toBe(true);
        finish.resolve();
        await pendingWork?.catch(() => {});
        await Promise.all([closing, siblingClose]);
        expect.soft(queryError).toBeUndefined();
        expect.soft(reads).toEqual([{ value: 42 }]);
        expect(database.isOpen).toBe(false);

        // The SDK Server supports a new connection after its preceding close settles.
        database = new DatabaseSync(":memory:");
        const nextClient = await connect();
        await expect(
          nextClient.callTool({ name: tool.name, arguments: {} }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: mode === "handler" ? "done" : "accepted" }],
        });
        await pendingWork;
        expect(reads.at(-1)).toEqual({ value: 42 });
      } finally {
        finish.resolve();
        await pendingWork?.catch(() => {});
        await closing;
        await siblingClose;
        await Promise.all(clients.map((client) => client.close()));
        await server.close();
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("does not execute a request queued in SDK microtasks when close starts", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE calls (value INTEGER)");
    const tool: AnyAgentTool = {
      name: "queued_write",
      label: "Queued write",
      description: "Records actual tool admission",
      parameters: Type.Object({}),
      execute: async () => {
        database.prepare("INSERT INTO calls VALUES (1)").run();
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    };
    const server = createToolsMcpServer({ name: "queued-admission", tools: [tool] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "queued-client", version: "0.0.0" }, { capabilities: {} });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const sent = clientTransport.send({
        jsonrpc: "2.0",
        id: "queued-before-close",
        method: "tools/call",
        params: { name: tool.name, arguments: {} },
      });
      await server.close();
      await sent;
      await nextTurn();
      expect(database.prepare("SELECT count(*) AS count FROM calls").get()).toEqual({ count: 0 });
    } finally {
      await client.close();
      await server.close();
      database.close();
    }
  });
});
