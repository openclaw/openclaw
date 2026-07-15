import type {
  ChatCommandDefinition,
  CommandCategory,
  CommandTier,
} from "./commands-registry.types.js";

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
    defineChatCommand({
      key: "mark",
      nativeName: "mark",
      description: "Mark the current session with a preset symbol.",
      textAlias: "/mark",
      acceptsArgs: true,
      category: "session",
      tier: "standard",
      args: [
        {
          name: "mark",
          description: "Choose a mark or clear it",
          type: "string",
          choices: [
            { value: "in-progress", label: "🚧 In progress" },
            { value: "completed", label: "✅ Completed" },
            { value: "paused", label: "⏸️ Paused" },
            { value: "urgent", label: "🔥 Urgent" },
            { value: "keep", label: "📌 Keep" },
            { value: "idea", label: "💡 Idea" },
            { value: "clear", label: "Clear mark" },
          ],
        },
      ],
      argsMenu: "auto",
    }),
  ];
}
