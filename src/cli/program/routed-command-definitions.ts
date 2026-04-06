import { defaultRuntime } from "../../runtime.js";
import type { CliRoutedCommandId } from "../command-catalog.js";
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

export type RoutedCommandDefinition<TArgs = unknown> = {
  parseArgs: (argv: string[]) => TArgs | null;
  runParsedArgs: (args: TArgs) => Promise<void>;
};

export const routedCommandDefinitions: Record<CliRoutedCommandId, RoutedCommandDefinition> = {
  health: {
    parseArgs: parseHealthRouteArgs,
    runParsedArgs: async (args) => {
      const { healthCommand } = await import("../../commands/health.js");
      await healthCommand(args, defaultRuntime);
    },
  },
  status: {
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
  },
  "gateway-status": {
    parseArgs: parseGatewayStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { runDaemonStatus } = await import("../daemon-cli/status.js");
      await runDaemonStatus(args);
    },
  },
  sessions: {
    parseArgs: parseSessionsRouteArgs,
    runParsedArgs: async (args) => {
      const { sessionsCommand } = await import("../../commands/sessions.js");
      await sessionsCommand(args, defaultRuntime);
    },
  },
  "agents-list": {
    parseArgs: parseAgentsListRouteArgs,
    runParsedArgs: async (args) => {
      const { agentsListCommand } = await import("../../commands/agents.js");
      await agentsListCommand(args, defaultRuntime);
    },
  },
  "config-get": {
    parseArgs: parseConfigGetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigGet } = await import("../config-cli.js");
      await runConfigGet(args);
    },
  },
  "config-unset": {
    parseArgs: parseConfigUnsetRouteArgs,
    runParsedArgs: async (args) => {
      const { runConfigUnset } = await import("../config-cli.js");
      await runConfigUnset(args);
    },
  },
  "models-list": {
    parseArgs: parseModelsListRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsListCommand } = await import("../../commands/models.js");
      await modelsListCommand(args, defaultRuntime);
    },
  },
  "models-status": {
    parseArgs: parseModelsStatusRouteArgs,
    runParsedArgs: async (args) => {
      const { modelsStatusCommand } = await import("../../commands/models.js");
      await modelsStatusCommand(args, defaultRuntime);
    },
  },
};
