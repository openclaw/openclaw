// Plugin MCP cancellation tests cover cancellation of in-flight plugin tool calls.
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { consumeTrackedToolExecutionStarted } from "../agents/agent-tools.before-tool-call.state.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
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

  it.each(
    ["handler", "descendant"].flatMap((mode) => [false, true].map((hosted) => ({ mode, hosted }))),
  )(
    "joins native $mode work before close and reconnect (SDK host: $hosted)",
    async ({ mode, hosted }) => {
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
      const sdkResourceHost = hosted ? new LegacyPluginSdkResourceHost() : undefined;
      const server = createToolsMcpServer({ name: "native-drain", tools: [tool], sdkResourceHost });
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
        await sdkResourceHost?.close();
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it.each(
    [false, true].flatMap((hosted) =>
      ["send-pending", "response-completed"].map((phase) => ({ hosted, phase })),
    ),
  )(
    "keeps late descendant cancellation during $phase (SDK host: $hosted)",
    async ({ hosted, phase }) => {
      const database = new DatabaseSync(":memory:");
      const host = hosted ? new LegacyPluginSdkResourceHost() : undefined;
      const lateListener = createDeferred();
      const listening = createDeferred();
      const finish = createDeferred();
      const workAborted = createDeferred();
      const responseEntered = createDeferred();
      const releaseResponse = createDeferred();
      const transportClosed = createDeferred();
      const reads: unknown[] = [];
      let requestSignal: AbortSignal | undefined;
      let workSignal: AbortSignal | undefined;
      let descendant: Promise<void> | undefined;
      let descendantFinished = false;
      let responseId: number | string | undefined;
      let abortCount = 0;
      let observedReason: unknown;
      let closeFinished = false;
      const tool: AnyAgentTool = {
        name: "cached_native_work",
        label: "Cached native work",
        description: "Returns a cached result while accepted native work remains",
        parameters: Type.Object({}),
        execute: async (_id, _params, signal) => {
          const ownerSignal = getAsyncWorkSignal();
          if (!signal || !ownerSignal) {
            throw new Error("Expected request and work signals");
          }
          requestSignal = signal;
          workSignal = ownerSignal;
          descendant = trackAsyncWork(async () => {
            await lateListener.promise;
            const observeAbort = () => {
              abortCount++;
              observedReason = signal.reason;
            };
            const observeWorkAbort = () => workAborted.resolve();
            signal.addEventListener("abort", observeAbort, { once: true });
            ownerSignal.addEventListener("abort", observeWorkAbort, { once: true });
            if (signal.aborted) {
              observeAbort();
            }
            if (ownerSignal.aborted) {
              observeWorkAbort();
            }
            listening.resolve();
            try {
              await finish.promise;
              if (phase === "response-completed") {
                await workAborted.promise;
              }
              reads.push(database.prepare("SELECT 42 AS value").get());
            } finally {
              signal.removeEventListener("abort", observeAbort);
              ownerSignal.removeEventListener("abort", observeWorkAbort);
              descendantFinished = true;
            }
          });
          void descendant.catch(() => {});
          return { content: [{ type: "text", text: "cached result" }], details: {} };
        },
      };
      const server = createToolsMcpServer({
        name: "native-response-tail",
        tools: [tool],
        sdkResourceHost: host,
      });
      const client = new Client({ name: "native-response-client", version: "0.0.0" });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes callback properties, not EventTarget.
      client.onclose = () => transportClosed.resolve();
      const [outbound, inbound] = InMemoryTransport.createLinkedPair();
      const sendRequest = outbound.send.bind(outbound);
      const requestSpy = vi.spyOn(outbound, "send").mockImplementation(async (message, options) => {
        if ("method" in message && message.method === "tools/call" && "id" in message) {
          responseId = message.id;
        }
        return await sendRequest(message, options);
      });
      const sendResponse = inbound.send.bind(inbound);
      const responseSpy = vi.spyOn(inbound, "send").mockImplementation(async (message, options) => {
        if ("result" in message && message.id === responseId) {
          responseEntered.resolve();
          if (phase === "send-pending") {
            await releaseResponse.promise;
          }
        }
        return await sendResponse(message, options);
      });
      let call: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      const reason = "cancel while response transport is pending";
      try {
        await Promise.all([server.connect(inbound), client.connect(outbound)]);
        const controller = new AbortController();
        call = client.callTool({ name: tool.name }, undefined, { signal: controller.signal }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        await Promise.race([
          responseEntered.promise,
          call.then(() => {
            throw new Error("The call settled before response sending began");
          }),
        ]);
        expect(descendantFinished).toBe(false);
        if (phase === "response-completed") {
          expect(await call).toMatchObject({ result: { content: [{ text: "cached result" }] } });
          await client.ping();
        }
        expect(workSignal?.aborted).toBe(false);
        lateListener.resolve();
        await listening.promise;
        if (phase === "send-pending") {
          controller.abort(reason);
        } else {
          if (responseId === undefined) {
            throw new Error("Expected the actual request ID");
          }
          await client.notification({
            method: "notifications/cancelled",
            params: { requestId: responseId, reason },
          });
        }
        // A public ping reply follows the preceding cancellation notification.
        await client.ping();
        expect(abortCount).toBe(phase === "send-pending" ? 1 : 0);
        expect(requestSignal?.aborted).toBe(phase === "send-pending");
        expect(observedReason).toBe(phase === "send-pending" ? reason : undefined);
        expect(workSignal?.aborted).toBe(false);
        releaseResponse.resolve();
        await call;
        await client.ping();
        closing = server.close().then(() => {
          database.close();
          closeFinished = true;
        });
        await transportClosed.promise;
        await nextTurn();
        expect(workSignal?.aborted).toBe(true);
        expect(closeFinished).toBe(false);
        expect(database.isOpen).toBe(true);
        finish.resolve();
        await descendant;
        await closing;
        expect(reads).toEqual([{ value: 42 }]);
        expect(database.isOpen).toBe(false);
      } finally {
        lateListener.resolve();
        finish.resolve();
        workAborted.resolve();
        releaseResponse.resolve();
        await descendant;
        await closing;
        await server.close();
        await client.close();
        await call;
        await host?.close();
        requestSpy.mockRestore();
        responseSpy.mockRestore();
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
