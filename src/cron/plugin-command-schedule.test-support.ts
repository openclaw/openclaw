import { currentPluginCommandHostProcessId } from "./plugin-command-schedule.js";
import type { PluginCommandSchedule } from "./plugin-command-schedule.types.js";

export function pluginCommandSchedule(
  nowMs: number,
  overrides: Partial<PluginCommandSchedule> = {},
): PluginCommandSchedule {
  return {
    version: 1,
    pluginId: "watcher",
    pluginIncarnation: "synthetic-plugin-incarnation",
    hostProcessId: currentPluginCommandHostProcessId(),
    pluginSource: "/plugins/watcher/index.js",
    pluginRoot: "/plugins/watcher",
    pluginVersion: "1.0.0",
    command: "watcher-resume",
    args: "synthetic-workflow",
    channel: "webchat",
    parent: { agentId: "main", sessionKey: "agent:main:parent", sessionId: "parent-incarnation" },
    sourceRunId: "command-run",
    operatorSource: {
      kind: "gateway",
      snapshot: {
        profileId: "synthetic-operator",
        scopes: ["operator.read", "operator.write"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "synthetic-generation",
          role: "operator",
          authMethod: "token",
        },
        controlUiAdmin: false,
        localOperator: true,
        sourceIngress: "internal",
      },
    },
    toolsAllow: ["sessions_spawn", "agents_wait"],
    deadlineAtMs: nowMs + 60_000,
    maxRuns: 2,
    ...overrides,
  };
}
