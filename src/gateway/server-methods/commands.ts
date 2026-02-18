import type { GatewayRequestHandlers } from "./types.js";
import { listChatCommands } from "../../auto-reply/commands-registry.js";

export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": ({ respond }) => {
    const commands = listChatCommands();
    const result = commands.map((cmd) => ({
      name: cmd.nativeName ?? cmd.key,
      description: cmd.description,
      category: cmd.category ?? "general",
      acceptsArgs: cmd.acceptsArgs,
      args: cmd.args?.map((arg) => ({
        name: arg.name,
        description: arg.description,
        choices: Array.isArray(arg.choices)
          ? arg.choices.map((c) => (typeof c === "string" ? { value: c, label: c } : c))
          : undefined,
      })),
    }));
    respond(true, result);
  },
};
