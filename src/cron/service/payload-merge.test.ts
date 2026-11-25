import { expect, it } from "vitest";
import type { CronPayload, CronPayloadPatch } from "../types.js";
import { mergeCronPayload } from "./payload-merge.js";

type MergeCase = [string, CronPayload, CronPayloadPatch, CronPayload];
const event = { kind: "systemEvent", text: "before" } as const;
const agent = { kind: "agentTurn", message: "after" } as const;
const command = { kind: "command", argv: ["echo", "after"] } as const;
const tools = { toolsAllow: ["read", "cron"] };
const defaultTools = { ...tools, toolsAllowIsDefault: true };

const agentPayload = {
  kind: "agentTurn",
  message: "after",
  model: "provider/model",
  fallbacks: ["provider/fallback"],
  thinking: "high",
  timeoutSeconds: 30,
  lightContext: true,
  allowUnsafeExternalContent: false,
} satisfies CronPayload;
const commandPayload = {
  kind: "command",
  argv: ["echo", "after"],
  cwd: "/synthetic-workspace",
  env: { SYNTHETIC: "yes" },
  input: "stdin",
  timeoutSeconds: 30,
  noOutputTimeoutSeconds: 5,
  outputMaxBytes: 1024,
} satisfies CronPayload;

const mergeCases = [
  [
    "preserves systemEvent toolsAllow when omitted",
    { ...event, ...tools },
    { kind: "systemEvent", text: "after" },
    { ...event, text: "after", ...tools },
  ],
  [
    "updates systemEvent toolsAllow",
    { ...event, ...tools },
    { kind: "systemEvent", toolsAllow: ["cron"] },
    { ...event, toolsAllow: ["cron"] },
  ],
  [
    "preserves toolsAllow from agentTurn to command",
    { ...agent, message: "before", ...tools },
    { ...command, argv: [...command.argv] },
    { ...command, argv: [...command.argv], ...tools },
  ],
  ["systemEvent to agentTurn with overrides", event, structuredClone(agentPayload), agentPayload],
  [
    "systemEvent to command with execution settings",
    event,
    structuredClone(commandPayload),
    commandPayload,
  ],
  [
    "command to script with execution limits",
    { kind: "command", argv: ["echo", "before"] },
    { kind: "script", script: "return {};", timeoutSeconds: 30, toolBudget: 5 },
    { kind: "script", script: "return {};", timeoutSeconds: 30, toolBudget: 5 },
  ],
  [
    "installs a newly stamped default marker on command",
    { kind: "command", argv: ["echo", "before"] },
    { kind: "command", ...defaultTools },
    { kind: "command", argv: ["echo", "before"], ...defaultTools },
  ],
  [
    "clears toolsAllow explicitly across a kind change",
    { ...event, ...tools },
    { ...agent, toolsAllow: null },
    agent,
  ],
  [
    "preserves default-cap provenance across a kind change",
    { ...event, ...defaultTools },
    agent,
    { ...agent, ...defaultTools },
  ],
] satisfies MergeCase[];

it.each(mergeCases)("%s", (_label, existing, patch, expected) => {
  expect(mergeCronPayload(structuredClone(existing), structuredClone(patch))).toEqual(expected);
});
