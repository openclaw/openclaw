import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { invokeGatewayTool, type ToolsInvokeInput } from "../../gateway/tools-invoke-shared.js";
import type { OpenClawPluginToolContext } from "../tool-types.js";
import type { DeepReadonly, PluginRuntimeTools } from "./types-core.js";

type RuntimeConfigSnapshot = OpenClawConfig | DeepReadonly<OpenClawConfig>;

function resolveContextConfig(params: {
  ctx?: Pick<OpenClawPluginToolContext, "runtimeConfig" | "getRuntimeConfig" | "config">;
  getRuntimeConfig?: () => RuntimeConfigSnapshot;
}): RuntimeConfigSnapshot {
  const cfg = params.ctx?.runtimeConfig ?? params.ctx?.getRuntimeConfig?.() ?? params.ctx?.config;
  if (cfg) {
    return cfg;
  }
  return params.getRuntimeConfig?.() ?? {};
}

function stringThreadId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function createRuntimeTools(
  options: {
    getRuntimeConfig?: () => RuntimeConfigSnapshot;
  } = {},
): PluginRuntimeTools {
  return {
    async invoke(params) {
      const cfg = resolveContextConfig({
        ctx: params.ctx,
        getRuntimeConfig: options.getRuntimeConfig,
      });
      const deliveryContext = params.ctx?.deliveryContext;
      const input: ToolsInvokeInput = {
        tool: params.tool,
        action: params.action,
        args: params.args,
        idempotencyKey: params.idempotencyKey,
        dryRun: params.dryRun,
        sessionKey: params.ctx?.sessionKey,
        agentId: params.ctx?.agentId,
      };

      return await invokeGatewayTool({
        cfg: cfg as OpenClawConfig,
        input,
        senderIsOwner: params.ctx?.senderIsOwner === true,
        messageChannel: params.ctx?.messageChannel ?? deliveryContext?.channel,
        accountId: params.ctx?.agentAccountId ?? deliveryContext?.accountId,
        agentTo: deliveryContext?.to,
        agentThreadId: stringThreadId(deliveryContext?.threadId),
        toolCallIdPrefix: params.toolCallIdPrefix ?? "runtime",
        approvalMode: params.approvalMode,
        surface: "loopback",
        widenRequestedPluginTool: false,
        excludeToolNames: ["lobster"],
        signal: params.signal,
      });
    },
  };
}
