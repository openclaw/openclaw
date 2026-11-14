import type { Command } from "commander";
import { callGatewayCli } from "../gateway/call.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

const disposeAllSessionMcpRuntimes = createLazyRuntimeMethod(
  () => import("../agents/agent-bundle-mcp-manager-api.js"),
  (runtime) => runtime.disposeAllSessionMcpRuntimes,
);

export function registerMcpReloadCommand(mcp: Command): void {
  mcp
    .command("reload")
    .description("Reload cached MCP runtimes (CLI + configured Gateway) from the published config")
    .action(async () => {
      let gatewayReloaded = false;
      let gatewayConfigApplied = true;
      let gatewayError: string | undefined;
      try {
        // The Gateway process owns its own cached session MCP runtimes; the
        // CLI-local dispose below cannot reach them (#164642).
        const result = await callGatewayCli<{ reloaded?: boolean; configApplied?: boolean }>({
          method: "mcp.reloadRuntimes",
          params: {},
          timeoutMs: 10_000,
        });
        gatewayReloaded = result.reloaded !== false;
        gatewayConfigApplied = result.configApplied !== false;
      } catch (err) {
        gatewayError = err instanceof Error ? err.message : String(err);
      }
      await disposeAllSessionMcpRuntimes();
      if (gatewayReloaded && gatewayConfigApplied) {
        defaultRuntime.log(
          "Reloaded MCP runtimes (Gateway + CLI). Active agents use new MCP config on their next runtime build.",
        );
      } else if (gatewayReloaded) {
        defaultRuntime.log(
          "Reloaded MCP runtimes (Gateway + CLI) from the published config. gateway.reload.mode=off leaves pending on-disk config edits unapplied until config reload is re-enabled.",
        );
      } else {
        defaultRuntime.log(
          gatewayError
            ? `Disposed cached CLI-local MCP runtimes. Gateway-side reload was not confirmed (${gatewayError}); active Gateway agents may keep the previous MCP config until the Gateway reloads it.`
            : "Disposed cached CLI-local MCP runtimes. No Gateway is configured, so CLI-local runtimes were the only cached ones.",
        );
      }
    });
}
