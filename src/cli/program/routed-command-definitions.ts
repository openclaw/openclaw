import { defaultRuntime } from "../../runtime.js";
import {
  parseAgentsListRouteArgs,
  parseConfigGetRouteArgs,
  parseConfigUnsetRouteArgs,
  parseGatewayStatusRouteArgs,
  parseHealthRouteArgs,
  parseModelsListRouteArgs,
  parseModelsStatusRouteArgs,
  parseSessionsRouteArgs,
  parseStatusRouteArgs,
} from "./route-args.js";

type RouteArgParser<TArgs> = (argv: string[]) => TArgs | null;

type ParsedRouteArgs<TParse extends RouteArgParser<unknown>> = Exclude<ReturnType<TParse>, null>;

export type RoutedCommandDefinition<TParse extends RouteArgParser<unknown>> = {
  parseArgs: TParse;
  runParsedArgs: (args: ParsedRouteArgs<TParse>) => Promise<void>;
};

export type AnyRoutedCommandDefinition = RoutedCommandDefinition<RouteArgParser<unknown>>;

function defineRoutedCommand<TParse extends RouteArgParser<unknown>>(
  definition: RoutedCommandDefinition<TParse>,
): RoutedCommandDefinition<TParse> {
  return definition;
}

export const routedCommandDefinitions = {
  health: defineRoutedCommand({
    parseArgs: parseHealthRouteArgs,
    runParsedArgs: async (args) => {
      const { healthCommand } = await import("../../commands/health.js");
      await healthCommand(args, defaultRuntime);
    },
  }),
  status: defineRoutedCommand({
    parseArgs: parseStatusRouteArgs,
    runParsedArgs: async (args) => {
      if (args.json) {
        const { statusJsonCommand } = await import("../../commands/status-json.js");
        await statusJsonCommand(
          {
            deep: args.deep,
            all: args.all,
            usage: args.usage,
            timeoutMs: args.timeoutMs,
          },
          defaultRuntime,
        );
        return;
      }
      const { statusCommand } = await import("../../commands/status.js");
      await statusCommand(args, defaultRuntime);
    },
  }),
  "gateway-status": defineRoutedCommand({
    parseArgs: parseGatewayStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { runDaemonStatus } = await import("../daemon-cli/status.js");
      await runDaemonStatus(args);
    },
  }),
  sessions: defineRoutedCommand({
    parseArgs: parseSessionsRouteArgs,
    runParsedArgs: async (args) => {
      const { sessionsCommand } = await import("../../commands/sessions.js");
      await sessionsCommand(args, defaultRuntime);
    },
  }),
  "agents-list": defineRoutedCommand({
    parseArgs: parseAgentsListRouteArgs,
    runParsedArgs: async (args) => {
      const { agentsListCommand } = await import("../../commands/agents.js");
      await agentsListCommand(args, defaultRuntime);
    },
  }),
  "config-get": defineRoutedCommand({
    parseArgs: parseConfigGetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigGet } = await import("../config-cli.js");
      await runConfigGet(args);
    },
  }),
  "config-unset": defineRoutedCommand({
    parseArgs: parseConfigUnsetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigUnset } = await import("../config-cli.js");
      await runConfigUnset(args);
    },
  }),
  "models-list": defineRoutedCommand({
    parseArgs: parseModelsListRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsListCommand } = await import("../../commands/models.js");
      await modelsListCommand(args, defaultRuntime);
    },
  }),
  "models-status": defineRoutedCommand({
    parseArgs: parseModelsStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsStatusCommand } = await import("../../commands/models.js");
      await modelsStatusCommand(args, defaultRuntime);
    },
  }),
};
