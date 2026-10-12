import type { PluginCompatRecord } from "./types.js";

export const SKILL_COMMAND_DISCOVERY_COMPAT_RECORD = {
  code: "skill-command-discovery-sync",
  status: "deprecated",
  owner: "sdk",
  introduced: "2026-04-02",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removalGate: "next-plugin-sdk-major",
  replacement:
    "Await prepareSkillCommandsForAgents or prepareSkillCommandsForWorkspace. Synchronous list methods retain their array results until the next Plugin SDK major and explicit breaking-release approval.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-skill-command-discovery",
  surfaces: [
    "openclaw/plugin-sdk/skill-commands-runtime.listSkillCommandsForAgents",
    "openclaw/plugin-sdk/skill-commands-runtime.listSkillCommandsForWorkspace",
    "openclaw/plugin-sdk/command-auth-native.listSkillCommandsForAgents",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and one runtime warning per plugin and capability family",
  ],
  tests: [
    "src/plugins/compat/registry.test.ts",
    "src/skills/discovery/chat-commands.discovery.test.ts",
    "extensions/discord/src/monitor/provider.commands.test.ts",
    "extensions/telegram/src/bot-native-commands.registry.test.ts",
  ],
  releaseNote:
    "Native command discovery awaits managed-library selection through the existing worker. Bundled channels use the async methods; synchronous SDK methods remain available during their migration window.",
} as const satisfies PluginCompatRecord;
