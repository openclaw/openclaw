import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isJSONRPCRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpProofPluginRegistry } from "../src/agents/mcp-connection-resolver.test-fixtures.js";
import { runWithMcpRequestContext } from "../src/agents/mcp-request-context.js";
import { resolveMcpTransport } from "../src/agents/mcp-transport.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";
import { createDeferred } from "./helpers/promise.js";

describe("PR #154043 real runtime proof", () => {
  it("dispatches attributed calls and rejects canceled calls before HTTP I/O", async () => {
    const requests: Array<{
      httpMethod: string | undefined;
      rpcMethod?: string;
      toolName?: unknown;
      attribution: string | string[] | undefined;
    }> = [];
    const notificationStreamReceived = createDeferred();
    const providerEntered = createDeferred();
    const releaseProvider = createDeferred();
    const cancellationSent = createDeferred();
    const canceledSendFinished = createDeferred<
      { status: "fulfilled" } | { status: "rejected"; error: unknown }
    >();
    const client = new Client({ name: "pr154043-proof", version: "1.0.0" });
    const server = createServer((request, response) => {
      const recorded: (typeof requests)[number] = {
        httpMethod: request.method,
        attribution: request.headers["x-proof-attribution"],
      };
      requests.push(recorded);
      if (request.method !== "POST") {
        response.writeHead(405).end();
        notificationStreamReceived.resolve();
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const message = JSONRPCMessageSchema.parse(JSON.parse(body));
        if ("method" in message) {
          recorded.rpcMethod = message.method;
          recorded.toolName = message.params?.name;
        }
        if (!isJSONRPCRequest(message)) {
          response.writeHead(202).end();
          return;
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params?.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "pr154043-loopback", version: "1.0.0" },
              }
            : { content: [{ type: "text", text: "synthetic tool completed" }] };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });

    let restoreSend: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("proof server did not bind a loopback port");
      }
      const proof = createMcpProofPluginRegistry();
      let heldRequest = false;
      proof.apiFor("proof-attribution").registerMcpServerRequestHeaderProvider({
        serverName: "proof",
        async resolve(context) {
          if (context.runId === "canceled" && !heldRequest) {
            heldRequest = true;
            providerEntered.resolve();
            await releaseProvider.promise;
          }
          return { "x-proof-attribution": `synthetic-${context.runId}` };
        },
      });
      const resolved = withPluginRuntimeRegistryScope(proof.registry, () =>
        resolveMcpTransport("proof", {
          transport: "streamable-http",
          url: `http://127.0.0.1:${address.port}/mcp`,
        }),
      );
      if (!resolved) {
        throw new Error("proof MCP transport did not resolve");
      }
      const { transport } = resolved;
      const send = transport.send.bind(transport);
      // The SDK rejects the RPC before its pending HTTP send finishes. Observe the
      // real send's settlement so the zero-I/O assertion cannot race its dispatch.
      const sendObserver = vi
        .spyOn(transport, "send")
        .mockImplementation(async (message, options) => {
          const canceledCall =
            isJSONRPCRequest(message) &&
            message.method === "tools/call" &&
            message.params?.name === "canceled_operation";
          try {
            await send(message, options);
            if (canceledCall) {
              canceledSendFinished.resolve({ status: "fulfilled" });
            }
          } catch (error) {
            if (canceledCall) {
              canceledSendFinished.resolve({ status: "rejected", error });
            }
            throw error;
          } finally {
            if ("method" in message && message.method === "notifications/cancelled") {
              cancellationSent.resolve();
            }
          }
        });
      restoreSend = () => sendObserver.mockRestore();

      await client.connect(transport);
      await notificationStreamReceived.promise;
      const allowed = await runWithMcpRequestContext(
        { sessionId: "proof-session", runId: "allowed" },
        () => client.callTool({ name: "allowed_operation" }),
      );
      expect(allowed).toMatchObject({
        content: [{ type: "text", text: "synthetic tool completed" }],
      });
      expect(requests.filter((request) => request.toolName === "allowed_operation")).toEqual([
        {
          httpMethod: "POST",
          rpcMethod: "tools/call",
          toolName: "allowed_operation",
          attribution: "synthetic-allowed",
        },
      ]);
      console.log("[pr154043-proof] allowed: real tools/call arrived with volatile header present");

      const operation = new AbortController();
      const canceled = runWithMcpRequestContext(
        { sessionId: "proof-session", runId: "canceled" },
        () =>
          client.callTool({ name: "canceled_operation" }, undefined, { signal: operation.signal }),
      );
      const rejected = expect(canceled).rejects.toThrow("synthetic operation canceled");
      await providerEntered.promise;
      operation.abort(new Error("synthetic operation canceled"));
      await rejected;
      // Cancellation itself is a separate SDK notification, not a tool dispatch.
      await cancellationSent.promise;
      const requestCount = requests.length;
      releaseProvider.resolve();
      const sendResult = await canceledSendFinished.promise;
      expect(requests).toHaveLength(requestCount);
      expect(requests.filter((request) => request.toolName === "canceled_operation")).toEqual([]);
      expect(sendResult).toMatchObject({ status: "rejected", error: expect.any(Error) });
      console.log(
        "[pr154043-proof] canceled: rejected before I/O, server request count unchanged; pending send settled",
      );

      await runWithMcpRequestContext({ sessionId: "proof-session", runId: "after-cancel" }, () =>
        client.callTool({ name: "after_cancel_operation" }),
      );
      expect(
        requests.find((request) => request.toolName === "after_cancel_operation"),
      ).toMatchObject({
        attribution: "synthetic-after-cancel",
      });
      console.log("[pr154043-proof] shared transport: subsequent attributed tools/call succeeded");
    } finally {
      releaseProvider.resolve();
      await client.close();
      restoreSend?.();
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
    }
  });
});
