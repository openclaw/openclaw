import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { VERSION } from "../version.js";
import { OpenClawChannelBridge } from "./channel-bridge.js";
import { ClaudePermissionRequestSchema, type ClaudeChannelMode } from "./channel-shared.js";
import { getChannelMcpCapabilities, registerChannelMcpTools } from "./channel-tools.js";

export { OpenClawChannelBridge } from "./channel-bridge.js";

export type OpenClawMcpServeOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  config?: OpenClawConfig;
  claudeChannelMode?: ClaudeChannelMode;
  verbose?: boolean;
};

async function resolveMcpConfig(config: OpenClawConfig | undefined): Promise<OpenClawConfig> {
  if (config) {
    return config;
  }
  const { getRuntimeConfig } = await import("../config/config.js");
  return getRuntimeConfig();
}

export async function createOpenClawChannelMcpServer(opts: OpenClawMcpServeOptions = {}): Promise<{
  server: McpServer;
  bridge: OpenClawChannelBridge;
  start: () => Promise<void>;
  close: () => Promise<void>;
}> {
  const cfg = await resolveMcpConfig(opts.config);
  const claudeChannelMode = opts.claudeChannelMode ?? "auto";
  const capabilities = getChannelMcpCapabilities(claudeChannelMode);
  const server = new McpServer(
    { name: "openclaw", version: VERSION },
    capabilities ? { capabilities } : undefined,
  );
  const bridge = new OpenClawChannelBridge(cfg, {
    gatewayUrl: opts.gatewayUrl,
    gatewayToken: opts.gatewayToken,
    gatewayPassword: opts.gatewayPassword,
    claudeChannelMode,
    verbose: opts.verbose ?? false,
  });
  bridge.setServer(server);

  server.server.setNotificationHandler(ClaudePermissionRequestSchema, async ({ params }) => {
    await bridge.handleClaudePermissionRequest({
      requestId: params.request_id,
      toolName: params.tool_name,
      description: params.description,
      inputPreview: params.input_preview,
    });
  });
  registerChannelMcpTools(server, bridge);

  return {
    server,
    bridge,
    start: async () => {
      await bridge.start();
    },
    close: async () => {
      await bridge.close();
      await server.close();
    },
  };
}

/**
 * How often to poll the parent process for liveness while the MCP child is
 * serving STDIO. Picked so a hung child closes within a few seconds of an
 * abrupt parent kill (e.g. `taskkill /F` on Windows or `kill -9` on POSIX),
 * but loose enough that healthy parents do not generate measurable load.
 *
 * Exported for tests; not part of the public API.
 */
export const MCP_PARENT_WATCHDOG_INTERVAL_MS = 5_000;

/**
 * How long after detecting that the parent is gone we wait for a clean
 * `close()` before force-exiting. Force-exit is the failure case for the
 * MCP orphan-worker class: the parent (gateway) is gone, the child's STDIO
 * pipe is wedged, and no SIGTERM is coming -- but the child still holds an
 * MCP protocol handshake in memory and will lose to the freshly-restarted
 * gateway on the next `openclaw mcp serve` connect.
 *
 * Exported for tests; not part of the public API.
 */
export const MCP_PARENT_GONE_GRACE_MS = 2_000;

function parentProcessIsAlive(parentPid: number): boolean {
  // `process.kill(pid, 0)` is a probe: it throws when the target does not
  // exist (or we lack permission). Cross-platform on Windows + POSIX.
  // Treat any thrown error other than EPERM as "gone" -- EPERM is the rare
  // case where a different uid owns a still-live pid; we should not kill
  // ourselves in that case.
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") {
      // Permission denied but pid exists. Parent still alive from our POV.
      return true;
    }
    return false;
  }
}

export async function serveOpenClawChannelMcp(opts: OpenClawMcpServeOptions = {}): Promise<void> {
  const { server, start, close } = await createOpenClawChannelMcpServer(opts);
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
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
    transport["onclose"] = undefined;
    if (parentWatchdog !== undefined) {
      clearInterval(parentWatchdog);
      parentWatchdog = undefined;
    }
    close().then(resolveClosed, resolveClosed);
  };

  // Parent-PID watchdog: when the gateway (parent) is killed abruptly --
  // SIGKILL on POSIX, `taskkill /F` on Windows, OOM-killer, etc. -- our
  // STDIO pipe is left in a state where no `end`/`close` event ever fires
  // and the MCP server stays running. Across an `openclaw` npm upgrade that
  // stale child holds the previous protocol version in memory and the next
  // gateway boot loses the handshake (the "protocol mismatch after upgrade"
  // class of bug). Poll the parent PID and exit cleanly when it disappears,
  // force-exiting after a short grace window if a clean close stalls.
  const parentPid = typeof process.ppid === "number" && process.ppid > 1 ? process.ppid : 0;
  let parentWatchdog: ReturnType<typeof setInterval> | undefined;
  if (parentPid > 0) {
    parentWatchdog = setInterval(() => {
      if (shuttingDown) return;
      if (parentProcessIsAlive(parentPid)) return;
      // Parent is gone. Begin shutdown immediately; if a clean close stalls
      // (closing the channel bridge needs network IO that may also be wedged),
      // force-exit after the grace window so we cannot become an orphan.
      shutdown();
      setTimeout(() => {
        // eslint-disable-next-line no-process-exit -- deliberate force-exit
        process.exit(0);
      }, MCP_PARENT_GONE_GRACE_MS).unref();
    }, MCP_PARENT_WATCHDOG_INTERVAL_MS);
    // Do not keep the event loop alive solely for this timer.
    parentWatchdog.unref?.();
  }

  transport["onclose"] = shutdown;
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await server.connect(transport);
    await start();
    await closed;
  } finally {
    shutdown();
    await closed;
  }
}
