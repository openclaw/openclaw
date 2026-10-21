import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isJSONRPCRequest, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpProofPluginRegistry } from "../src/agents/mcp-connection-resolver.test-fixtures.js";
import {
  bindMcpRequestRun,
  getMcpRequestContext,
  runWithMcpRequestContext,
} from "../src/agents/mcp-request-context.js";
import { resolveMcpTransport } from "../src/agents/mcp-transport.js";
import { withGuardedFetchRequestAuthority } from "../src/infra/net/fetch-request-authority.js";
import type { McpServerRequestContext } from "../src/plugin-sdk/agent-harness-runtime.js";
import { runWithMcpRequestMetadata } from "../src/plugin-sdk/agent-harness-runtime.js";
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
    const revocationProviderEntered = createDeferred();
    const releaseRevocationProvider = createDeferred();
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
      const signedRuns: string[] = [];
      proof.apiFor("proof-attribution").registerMcpServerRequestHeaderProvider({
        serverName: "proof",
        async resolve(context) {
          signedRuns.push(context.runId);
          if (context.runId === "revoked-authority") {
            revocationProviderEntered.resolve();
            await releaseRevocationProvider.promise;
          }
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
      const allowed = await bindMcpRequestRun(
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
      const canceled = bindMcpRequestRun({ sessionId: "proof-session", runId: "canceled" }, () =>
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

      await bindMcpRequestRun({ sessionId: "proof-session", runId: "after-cancel" }, () =>
        client.callTool({ name: "after_cancel_operation" }),
      );
      expect(
        requests.find((request) => request.toolName === "after_cancel_operation"),
      ).toMatchObject({
        attribution: "synthetic-after-cancel",
      });
      console.log("[pr154043-proof] shared transport: subsequent attributed tools/call succeeded");

      // Foreign identity: neither a forged context nor the public SDK helper can assert a run.
      const forged = Object.freeze({ sessionId: "victim-session", runId: "victim-run" });
      await runWithMcpRequestContext(forged, () =>
        client.callTool({ name: "forged_identity_operation" }),
      );
      await runWithMcpRequestMetadata({ traceparent: "caller-trace" }, () =>
        client.callTool({ name: "sdk_metadata_operation" }),
      );
      for (const toolName of ["forged_identity_operation", "sdk_metadata_operation"]) {
        expect(requests.find((request) => request.toolName === toolName)).toMatchObject({
          rpcMethod: "tools/call",
          attribution: undefined,
        });
      }
      expect(signedRuns).not.toContain("victim-run");
      console.log(
        "[pr154043-proof] foreign: forged and SDK-asserted identity reached the server unsigned; provider never saw victim-run",
      );

      // Reassigned identity: a context captured from a settled run is revoked before final I/O.
      let captured: McpServerRequestContext | undefined;
      await bindMcpRequestRun({ sessionId: "proof-session", runId: "settled" }, () => {
        captured = getMcpRequestContext();
      });
      expect(captured?.runId).toBe("settled");
      await runWithMcpRequestContext(captured, () =>
        client.callTool({ name: "settled_run_operation" }),
      );
      expect(
        requests.find((request) => request.toolName === "settled_run_operation"),
      ).toMatchObject({ rpcMethod: "tools/call", attribution: undefined });
      expect(signedRuns).not.toContain("settled");
      console.log(
        "[pr154043-proof] reassigned: settled run's captured context reached the server unsigned; provider never saw it",
      );

      // Caller authority revoked while headers resolve, with the MCP run still active.
      let callerAuthorityActive = true;
      const revokedCall = withGuardedFetchRequestAuthority(
        () => {
          if (!callerAuthorityActive) {
            throw new Error("synthetic caller authority revoked");
          }
        },
        () =>
          bindMcpRequestRun({ sessionId: "proof-session", runId: "revoked-authority" }, () =>
            client.callTool({ name: "revoked_authority_operation" }),
          ),
      );
      const revokedRejected = expect(revokedCall).rejects.toThrow(
        "synthetic caller authority revoked",
      );
      await revocationProviderEntered.promise;
      const beforeRevocation = requests.length;
      callerAuthorityActive = false;
      releaseRevocationProvider.resolve();
      await revokedRejected;
      expect(requests).toHaveLength(beforeRevocation);
      expect(
        requests.filter((request) => request.toolName === "revoked_authority_operation"),
      ).toEqual([]);
      console.log(
        "[pr154043-proof] revoked authority: provider resolved, caller authority revoked mid-resolution; rejected before I/O, server request count unchanged",
      );
    } finally {
      releaseProvider.resolve();
      releaseRevocationProvider.resolve();
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
