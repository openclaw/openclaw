import { expect, it } from "vitest";
import type { CronPayload, CronPayloadPatch } from "../types.js";
import { mergeCronPayload } from "./payload-merge.js";

type MergeCase = [string, CronPayload, CronPayloadPatch, CronPayload];
const beforeAgent = { kind: "agentTurn", message: "before" } as const;
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
    "preserves agentTurn toolsAllow when omitted",
    { ...beforeAgent, ...tools },
    { kind: "agentTurn", message: "after" },
    { ...agent, ...tools },
  ],
  [
    "updates agentTurn toolsAllow",
    { ...beforeAgent, ...tools },
    { kind: "agentTurn", toolsAllow: ["cron"] },
    { ...beforeAgent, toolsAllow: ["cron"] },
  ],
  [
    "preserves toolsAllow from agentTurn to command",
    { ...agent, message: "before", ...tools },
    { ...command, argv: [...command.argv] },
    { ...command, argv: [...command.argv], ...tools },
  ],
  ["command to agentTurn with overrides", command, structuredClone(agentPayload), agentPayload],
  [
    "agentTurn to command with execution settings",
    beforeAgent,
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
    { ...command, ...tools },
    { ...agent, toolsAllow: null },
    agent,
  ],
  [
    "preserves default-cap provenance across a kind change",
    { ...command, ...defaultTools },
    agent,
    { ...agent, ...defaultTools },
  ],
] satisfies MergeCase[];

it.each(mergeCases)("%s", (_label, existing, patch, expected) => {
  expect(mergeCronPayload(structuredClone(existing), structuredClone(patch))).toEqual(expected);
});
