import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createMcpConnection,
  createTool,
  toolResult,
  textResult,
  outcome,
  waitForStart,
} from "./tools-mcp.test-support.js";
import { createToolsMcpServer } from "./tools-stdio-server.js";

describe("plugin tools MCP cancellation", () => {
  it.each(
    [false, true].flatMap((hosted) =>
      ["send-pending", "response-completed"].map((phase) => ({ hosted, phase })),
    ),
  )(
    "drains and reconnects late descendant work during $phase (SDK host: $hosted)",
    async ({ hosted, phase }) => {
      let database = new DatabaseSync(":memory:");
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
      let responseId: number | string | undefined;
      let abortCount = 0;
      let observedReason: unknown;
      const tool = createTool("cached_native_work", async (_id, _params, signal) => {
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
          }
        });
        void descendant.catch(() => {});
        return toolResult("cached result");
      });
      const server = createToolsMcpServer({
        name: "native-response-tail",
        tools: [tool],
        sdkResourceHost: host,
      });
      const { client, inbound, connect } = createMcpConnection(server);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes callback properties, not EventTarget.
      client.onclose = () => transportClosed.resolve();
      let restoreResponse = () => {};
      let call: Promise<unknown> | undefined;
      let closing: Promise<void> | undefined;
      let siblingClose: Promise<void> | undefined;
      let reconnected: Client | undefined;
      const reason = "cancel while response transport is pending";
      try {
        await connect();
        const sendResponse = inbound.send.bind(inbound);
        const responseSpy = vi
          .spyOn(inbound, "send")
          .mockImplementation(async (message, options) => {
            if ("result" in message && responseId === undefined) {
              responseId = message.id;
              responseEntered.resolve();
              if (phase === "send-pending") {
                await releaseResponse.promise;
              }
            }
            return await sendResponse(message, options);
          });
        restoreResponse = () => responseSpy.mockRestore();
        const controller = new AbortController();
        call = outcome(client.callTool({ name: tool.name }, { signal: controller.signal }));
        await waitForStart(responseEntered.promise, call);
        if (phase === "response-completed") {
          expect(await call).toMatchObject({ result: textResult("cached result") });
          await client.ping();
        }
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
        closing = server.close().then(() => database.close());
        let siblingSettled = false;
        siblingClose = server.close().then(() => {
          siblingSettled = true;
        });
        await transportClosed.promise;
        await nextTurn();
        expect(server.transport).toBeUndefined();
        expect.soft(siblingSettled).toBe(false);
        expect(workSignal?.aborted).toBe(true);
        expect(database.isOpen).toBe(true);
        finish.resolve();
        await descendant;
        await Promise.all([closing, siblingClose]);
        expect(reads).toEqual([{ value: 42 }]);
        expect(database.isOpen).toBe(false);
        database = new DatabaseSync(":memory:");
        const next = createMcpConnection(server);
        reconnected = next.client;
        await next.connect();
        await expect(reconnected.callTool({ name: tool.name })).resolves.toMatchObject(
          textResult("cached result"),
        );
        await descendant;
        expect(reads).toEqual([{ value: 42 }, { value: 42 }]);
      } finally {
        lateListener.resolve();
        finish.resolve();
        workAborted.resolve();
        releaseResponse.resolve();
        await descendant;
        await closing;
        await siblingClose;
        await server.close();
        await client.close();
        await reconnected?.close();
        await call;
        await host?.close();
        restoreResponse();
        if (database.isOpen) {
          database.close();
        }
      }
    },
  );

  it("does not execute a request queued in SDK microtasks when close starts", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE calls (value INTEGER)");
    const tool = createTool("queued_write", async () => {
      database.prepare("INSERT INTO calls VALUES (1)").run();
      return toolResult("done");
    });
    const server = createToolsMcpServer({ name: "queued-admission", tools: [tool] });
    const { client, outbound, connect } = createMcpConnection(server);
    try {
      await connect();
      const sent = outbound.send({
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
