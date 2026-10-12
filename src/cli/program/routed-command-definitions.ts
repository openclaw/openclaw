import { defaultRuntime } from "../../runtime.js";
import {
  parseAgentsListRouteArgs,
  parseChannelsListRouteArgs,
  parseChannelsStatusRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayHealthRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parsePluginsListRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

function defineRoutedCommand<TArgs>(
  parseArgs: (argv: string[]) => TArgs | null,
  runParsedArgs: (args: TArgs) => Promise<void>,
) {
  return (argv: string[]) => {
    const args = parseArgs(argv);
    return args === null ? null : () => runParsedArgs(args);
  };
}

export const routedCommandDefinitions = {
  health: defineRoutedCommand(parseHealthRouteArgs, async (args) => {
    const { healthCommand } = await import("../../commands/health.js");
    await healthCommand(args, defaultRuntime);
  }),
  status: defineRoutedCommand(parseStatusRouteArgs, async (args) => {
    if (args.json) {
      const { statusJsonCommand } = await import("../../commands/status-json.js");
      await statusJsonCommand(
        {
          deep: args.deep,
          all: args.all,
          usage: args.usage,
          ...(args.agent !== undefined ? { agent: args.agent } : {}),
          timeoutMs: args.timeoutMs,
        },
        defaultRuntime,
      );
      return;
    }
    const { statusCommand } = await import("../../commands/status.js");
    await statusCommand(args, defaultRuntime);
  }),
  "gateway-status": defineRoutedCommand(parseGatewayStatusRouteArgs, async (args) => {
    const { runDaemonStatus } = await import("../daemon-cli/status.js");
    await runDaemonStatus(args);
  }),
  "gateway-health": defineRoutedCommand(parseGatewayHealthRouteArgs, async (args) => {
    const { runGatewayHealthJsonRoute } = await import("../gateway-cli/health-route.js");
    await runGatewayHealthJsonRoute(args, defaultRuntime);
  }),
  sessions: defineRoutedCommand(parseSessionsRouteArgs, async (args) => {
    const { sessionsCommand } = await import("../../commands/sessions.js");
    await sessionsCommand(args, defaultRuntime);
  }),
  "agents-list": defineRoutedCommand(parseAgentsListRouteArgs, async (args) => {
    const { agentsListCommand } = await import("../../commands/agents.commands.list.js");
    await agentsListCommand(args, defaultRuntime);
  }),
  "config-get": defineRoutedCommand(parseConfigGetRouteArgs, async (args) => {
    const { runConfigGet } = await import("../config-cli.js");
    await runConfigGet(args);
  }),
  "config-unset": defineRoutedCommand(parseConfigUnsetRouteArgs, async (args) => {
    const { runWithLocalStateOwner } = await import("../local-state-owner.js");
    await runWithLocalStateOwner({
      method: "config unset",
      params: {},
      target: args.path,
      onForeignOwner: "refuse",
      runLocal: async () => {
        const { runConfigUnset } = await import("../config-cli.js");
        await runConfigUnset(args);
      },
    });
  }),
  "models-list": defineRoutedCommand(parseModelsListRouteArgs, async (args) => {
    const { modelsListCommand } = await import("../../commands/models/list.list-command.js");
    await modelsListCommand(args, defaultRuntime);
  }),
  "models-status": defineRoutedCommand(parseModelsStatusRouteArgs, async (args) => {
    const { modelsStatusCommand } = await import("../../commands/models/list.status-command.js");
    await modelsStatusCommand(args, defaultRuntime);
  }),
  "channels-list": defineRoutedCommand(parseChannelsListRouteArgs, async (args) => {
    const { channelsListCommand } = await import("../../commands/channels/list.js");
    await channelsListCommand(args, defaultRuntime);
  }),
  "channels-status": defineRoutedCommand(parseChannelsStatusRouteArgs, async (args) => {
    const { channelsStatusCommand } = await import("../../commands/channels/status.js");
    await channelsStatusCommand(args, defaultRuntime);
  }),
  "plugins-list": defineRoutedCommand(parsePluginsListRouteArgs, async (args) => {
    const { runPluginsListCommand } = await import("../plugins-list-command.js");
    await runPluginsListCommand(args, defaultRuntime);
  }),
};
