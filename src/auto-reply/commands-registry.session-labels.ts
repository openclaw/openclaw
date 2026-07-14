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
          description: "Choose a mark, clear it, or switch language",
          type: "string",
          choices: [
            { value: "进行中", label: "🚧 进行中 / In progress" },
            { value: "已完成", label: "✅ 已完成 / Completed" },
            { value: "暂停", label: "⏸️ 暂停 / Paused" },
            { value: "紧急", label: "🔥 紧急 / Urgent" },
            { value: "常驻", label: "📌 常驻 / Keep" },
            { value: "想法", label: "💡 想法 / Idea" },
            { value: "clear", label: "清除标记 / Clear mark" },
            { value: "english", label: "English" },
            { value: "中文", label: "中文" },
          ],
        },
      ],
      argsMenu: "auto",
    }),
  ];
}
