import type { PluginCompatRecord } from "./types.js";

export const SKILL_COMMAND_DISCOVERY_COMPAT_RECORD = {
  code: "skill-command-discovery-sync",
  status: "deprecated",
  owner: "sdk",
  deprecated: "2026-10-11",
  warningStarts: "2026-10-11",
  removeAfter: "2026-12-31",
  replacement:
    "Await prepareSkillCommandsForAgents or prepareSkillCommandsForWorkspace. Synchronous list methods retain their array results through 2026-12-31; removal ships in the first January 2027 stable release without an SDK major.",
  docsPath: "/plugins/sdk-migration/how-to-migrate#await-skill-command-discovery",
  surfaces: [
    "openclaw/plugin-sdk/skill-commands-runtime.listSkillCommandsForAgents",
    "openclaw/plugin-sdk/skill-commands-runtime.listSkillCommandsForWorkspace",
    "openclaw/plugin-sdk/command-auth-native.listSkillCommandsForAgents",
  ],
  diagnostics: [
    "TypeScript @deprecated annotations and one runtime warning per plugin and capability family",
  ],
} as const satisfies PluginCompatRecord;
