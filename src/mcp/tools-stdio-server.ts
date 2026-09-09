// MCP stdio server exposes OpenClaw tools over the MCP stdio transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { VERSION } from "../version.js";
import { createPluginToolsMcpHandlers } from "./plugin-tools-handlers.js";

class ToolsMcpServer extends Server {
  #work = new AsyncWorkScope();
  #closing: Promise<void> | undefined;

  runRequest<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    // SDK request callbacks are queued in microtasks and may enter after transport closure.
    if (this.#closing || !this.transport) {
      return Promise.reject(McpError.fromError(ErrorCode.ConnectionClosed, "Connection closed"));
    }
    signal.throwIfAborted();
    return this.#work.track(run);
  }

  override close(): Promise<void> {
    if (this.#closing) {
      return this.#closing;
    }
    const closed = createDeferredCore();
    this.#closing = closed.promise;
    const work = this.#work;
    void (async () => {
      try {
        // Native close delivers cancellation; it does not join accepted tool work.
        await super.close();
      } finally {
        await work.drain();
        // The same SDK Server can connect again after this close has fully settled.
        this.#work = new AsyncWorkScope();
        this.#closing = undefined;
      }
    })().then(closed.resolve, closed.reject);
    return closed.promise;
  }
}

export function createToolsMcpServer(params: { name: string; tools: AnyAgentTool[] }): Server {
  const handlers = createPluginToolsMcpHandlers(params.tools);
  const server = new ToolsMcpServer(
    { name: params.name, version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    return await server.runRequest(handlers.listTools, extra.signal);
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    return await server.runRequest(
      async () => await handlers.callTool(request.params, extra.signal),
      extra.signal,
    );
  });

  return server;
}

export async function connectToolsMcpServerToStdio(
  server: Server,
  options: { onShutdown?: () => Promise<void> | void } = {},
): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only.
  routeLogsToStderr();

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  let resolveShutdown: (() => void) | undefined;
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    void (async () => {
      let shutdownError: unknown;
      try {
        await server.close();
      } catch (error) {
        shutdownError = error;
      }
      try {
        await options.onShutdown?.();
      } catch (error) {
        shutdownError ??= error;
      } finally {
        resolveShutdown?.();
      }
      if (shutdownError) {
        process.stderr.write(`MCP stdio shutdown failed: ${formatErrorMessage(shutdownError)}\n`);
      }
    })();
  };

  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
  } catch (error) {
    shutdown();
    await shutdownComplete;
    throw error;
  }
  if (options.onShutdown) {
    await shutdownComplete;
  }
}
