import type {
  ChatCommandDefinition,
  CommandCategory,
  CommandTier,
} from "./commands-registry.types.js";
import { buildMarkCommand } from "../../extensions/mark/command-definition.js";

type DefineChatCommandInput = {
  key: string;
  nativeName?: string;
  description: string;
  textAlias?: string;
  acceptsArgs?: boolean;
  category?: CommandCategory;
  tier?: CommandTier;
  args?: ChatCommandDefinition["args"];
  argsMenu?: ChatCommandDefinition["argsMenu"];
};

type DefineChatCommand = (command: DefineChatCommandInput) => ChatCommandDefinition;

export function buildSessionLabelCommands(
  defineChatCommand: DefineChatCommand,
): ChatCommandDefinition[] {
  return [
    defineChatCommand({
      key: "name",
      nativeName: "name",
      description: "Name or rename the current session.",
      textAlias: "/name",
      acceptsArgs: true,
      category: "session",
      tier: "standard",
      args: [
        {
          name: "title",
          description: "New session name (omit to see a suggestion)",
          type: "string",
          captureRemaining: true,
        },
      ],
    }),
    buildMarkCommand(defineChatCommand),
  ];
}
