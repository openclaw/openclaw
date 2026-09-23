import type { ThinkLevel } from "../../../auto-reply/thinking.shared.js";

type InheritedSpawnPreferenceCase = {
  name: string;
  task: string;
  requesterState: Readonly<Record<string, unknown>>;
  preferenceKey: "thinkingLevel" | "fastMode";
  expected: string | boolean;
  agentDefaults?: Readonly<Record<string, unknown>>;
  requesterAgent?: Readonly<Record<string, unknown>>;
  collect?: boolean;
  requesterRunId?: string;
  requesterThinkingLevel?: ThinkLevel;
  thinkingOverride?: string;
};

export const inheritedSpawnPreferenceCases: readonly InheritedSpawnPreferenceCase[] = [
  {
    name: "inherits requester thinking level when no spawn or subagent default is configured",
    task: "inherit thinking",
    requesterState: { thinkingLevel: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits active-turn Ultra instead of the stored session thinking level",
    task: "inherit active thinking",
    requesterState: { thinkingLevel: "medium" },
    requesterThinkingLevel: "ultra",
    preferenceKey: "thinkingLevel",
    expected: "ultra",
  },
  {
    name: "inherits active-turn off instead of a stored Ultra override",
    task: "inherit active thinking off",
    requesterState: { thinkingLevel: "ultra" },
    requesterThinkingLevel: "off",
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "keeps explicit child thinking ahead of active-turn Ultra",
    task: "override active thinking",
    requesterState: { thinkingLevel: "medium" },
    requesterThinkingLevel: "ultra",
    thinkingOverride: "low",
    preferenceKey: "thinkingLevel",
    expected: "low",
  },
  {
    name: "inherits requester fast mode for collector children",
    task: "inherit fast mode",
    requesterState: { fastMode: "auto" },
    preferenceKey: "fastMode",
    expected: "auto",
    collect: true,
    requesterRunId: "parent-run",
  },
  {
    name: "inherits requester fast mode for ordinary children with default Swarm config",
    task: "inherit ordinary fast mode",
    requesterState: { fastMode: true },
    preferenceKey: "fastMode",
    expected: true,
  },
  {
    name: "persists inherited requester thinking off",
    task: "inherit thinking off",
    requesterState: { thinkingLevel: "off" },
    preferenceKey: "thinkingLevel",
    expected: "off",
  },
  {
    name: "inherits requester agent thinkingDefault when the caller session has no stored thinking",
    task: "inherit agent thinking default",
    requesterState: {},
    requesterAgent: { thinkingDefault: "high" },
    preferenceKey: "thinkingLevel",
    expected: "high",
  },
  {
    name: "inherits global thinkingDefault when caller session and agent have no stored thinking",
    task: "inherit global thinking default",
    requesterState: {},
    agentDefaults: { thinkingDefault: "medium" },
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
  {
    name: "applies requester-agent subagent thinking before active-turn thinking",
    task: "requester policy thinking",
    requesterState: { thinkingLevel: "high" },
    requesterAgent: { subagents: { thinking: "medium" } },
    requesterThinkingLevel: "ultra",
    preferenceKey: "thinkingLevel",
    expected: "medium",
  },
];
