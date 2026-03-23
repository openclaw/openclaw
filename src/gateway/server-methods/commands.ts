import { listChatCommands } from "../../auto-reply/commands-registry.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type CommandArgChoice = string | { value: string; label: string };
type CommandArgDefinition = {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
  required?: boolean;
  choices?: CommandArgChoice[];
  preferAutocomplete?: boolean;
  captureRemaining?: boolean;
};
type ChatCommandCatalogEntry = {
  key: string;
  nativeName?: string;
  description: string;
  textAliases: string[];
  acceptsArgs: boolean;
  args?: CommandArgDefinition[];
  argsParsing?: string;
  argsMenu?: "auto" | { arg: string; title?: string };
  scope?: string;
  category?: string;
};

function isSerializableChoice(choice: unknown): choice is CommandArgChoice {
  return (
    typeof choice === "string" ||
    (typeof choice === "object" &&
      choice !== null &&
      typeof (choice as { value?: unknown }).value === "string" &&
      typeof (choice as { label?: unknown }).label === "string")
  );
}

function serializeCommandArgs(command: {
  args?: Array<{
    name: string;
    description: string;
    type: "string" | "number" | "boolean";
    required?: boolean;
    choices?: unknown;
    preferAutocomplete?: boolean;
    captureRemaining?: boolean;
  }>;
}): CommandArgDefinition[] | undefined {
  if (!Array.isArray(command.args) || command.args.length === 0) {
    return undefined;
  }

  const args = command.args.map((arg) => ({
    name: arg.name,
    description: arg.description,
    type: arg.type,
    required: arg.required,
    choices: Array.isArray(arg.choices)
      ? arg.choices.filter((choice): choice is CommandArgChoice => isSerializableChoice(choice))
      : undefined,
    preferAutocomplete: arg.preferAutocomplete,
    captureRemaining: arg.captureRemaining,
  }));

  return args.length > 0 ? args : undefined;
}

function serializeCommand(
  command: ReturnType<typeof listChatCommands>[number],
): ChatCommandCatalogEntry {
  return {
    key: command.key,
    nativeName: command.nativeName,
    description: command.description,
    textAliases: [...command.textAliases],
    acceptsArgs: command.acceptsArgs === true,
    args: serializeCommandArgs(command),
    argsParsing: command.argsParsing,
    argsMenu:
      command.argsMenu === "auto"
        ? "auto"
        : command.argsMenu
          ? {
              arg: command.argsMenu.arg,
              title: command.argsMenu.title,
            }
          : undefined,
    scope: command.scope,
    category: command.category,
  };
}

export const commandsHandlers: GatewayRequestHandlers = {
  "commands.list": ({ params, respond }) => {
    if (params != null && (typeof params !== "object" || Array.isArray(params))) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid commands.list params: expected object"),
      );
      return;
    }
    if (params && Object.keys(params).length > 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid commands.list params: unexpected property"),
      );
      return;
    }

    const commands = listChatCommands().map(serializeCommand);
    respond(true, { commands }, undefined);
  },
};
