// MCP stdio server exposes OpenClaw tools over the MCP stdio transport.
import { AsyncLocalStorage } from "node:async_hooks";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { routeLogsToStderr } from "../logging/console.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginToolRegistryAcquisition } from "../plugins/tools.js";
import { AsyncWorkScope, runWithTrackedCancellation } from "../shared/async-work-scope.js";
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
    const work = this.#work;
    return work.track(run);
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

export function createToolsMcpServer(params: {
  name: string;
  tools: AnyAgentTool[];
  sdkResourceHost?: LegacyPluginSdkResourceHost;
}): Server {
  const handlers = createPluginToolsMcpHandlers(params.tools);
  const server = new ToolsMcpServer(
    { name: params.name, version: VERSION },
    { capabilities: { tools: {} } },
  );
  const servingContext = params.sdkResourceHost?.run(() => AsyncLocalStorage.snapshot());
  const runInServingContext = <T>(run: () => T): T =>
    servingContext ? servingContext(run) : run();

  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    return await runInServingContext(() => server.runRequest(handlers.listTools, extra.signal));
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Restore serving authority before runRequest installs the accepted-work scope.
    return await runInServingContext(() =>
      server.runRequest(async () => {
        if (!params.sdkResourceHost) {
          return await handlers.callTool(request.params, extra.signal);
        }
        return await runWithTrackedCancellation(extra.signal, (signal) =>
          handlers.callTool(request.params, signal),
        );
      }, extra.signal),
    );
  });

  return server;
}

export async function connectToolsMcpServerToStdio(server: Server): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only.
  routeLogsToStderr();

  const closeFailures = new Set<unknown>();
  let shuttingDown = false;
  const shutdownComplete = createDeferredCore<unknown[]>();
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
      try {
        await server.close();
      } catch (error) {
        closeFailures.add(error);
      } finally {
        shutdownComplete.resolve([...closeFailures]);
      }
    })();
  };
  class OwnedStdioTransport extends StdioServerTransport {
    override async close(): Promise<void> {
      try {
        await super.close();
      } catch (error) {
        // SDK self-close can consume this rejection before the serving owner sees it.
        closeFailures.add(error);
        throw error;
      } finally {
        shutdown();
      }
    }
  }
  const transport = new OwnedStdioTransport();
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  const failures: unknown[] = [];
  try {
    await server.connect(transport);
  } catch (error) {
    failures.push(error);
    shutdown();
  }
  failures.push(...(await shutdownComplete.promise));
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "MCP connection and transport shutdown failed");
  }
}

/** Owns discovered registrations and nested SDK borrows for one terminal stdio service. */
export async function serveRegisteredToolsMcpServer(params: {
  acquireRegistry: () => Promise<PluginToolRegistryAcquisition>;
  createServer: (tools: AnyAgentTool[], sdkResourceHost: LegacyPluginSdkResourceHost) => Server;
}): Promise<void> {
  const sdkResourceHost = new LegacyPluginSdkResourceHost();
  let acquisition: PluginToolRegistryAcquisition | undefined;

  const failures: unknown[] = [];
  try {
    await sdkResourceHost.run(async () => {
      acquisition = await params.acquireRegistry();
      const owned = acquisition;
      await withPluginRuntimeRegistryScope(owned.registry, async () => {
        const server = params.createServer(owned.resolveTools(), sdkResourceHost);
        await connectToolsMcpServerToStdio(server);
      });
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await sdkResourceHost.run(async () => {
      const registry = acquisition?.registry;
      if (registry?.agentHarnesses.length) {
        try {
          const { disposeRegisteredAgentHarnesses } = await import("../agents/harness/registry.js");
          await withPluginRuntimeRegistryScope(registry, disposeRegisteredAgentHarnesses);
        } catch (error) {
          failures.push(error);
        }
      }
      // SDK results may retain the same source; both owners must release before physical disposal.
      const released = await Promise.allSettled([
        Promise.resolve().then(() => acquisition?.release()),
        Promise.resolve().then(() => sdkResourceHost.close()),
      ]);
      for (const result of released) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "MCP serving and registration cleanup failed");
  }
}
