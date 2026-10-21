import { expect, it } from "vitest";
import type { CronPayload, CronPayloadPatch } from "../types.js";
import { mergeCronPayload } from "./payload-merge.js";

type MergeCase = {
  label: string;
  existing: CronPayload;
  patch: CronPayloadPatch;
  expected: CronPayload;
};

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
  {
    label: "preserves systemEvent toolsAllow when omitted",
    existing: { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", text: "after" },
    expected: { kind: "systemEvent", text: "after", toolsAllow: ["read", "cron"] },
  },
  {
    label: "updates systemEvent toolsAllow",
    existing: { kind: "systemEvent", text: "tick", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", toolsAllow: ["cron"] },
    expected: { kind: "systemEvent", text: "tick", toolsAllow: ["cron"] },
  },
  {
    label: "preserves toolsAllow from agentTurn to command",
    existing: { kind: "agentTurn", message: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "command", argv: ["echo", "after"] },
    expected: { kind: "command", argv: ["echo", "after"], toolsAllow: ["read", "cron"] },
  },
  {
    label: "systemEvent to agentTurn with overrides",
    existing: { kind: "systemEvent", text: "before" },
    patch: structuredClone(agentPayload),
    expected: agentPayload,
  },
  {
    label: "systemEvent to command with execution settings",
    existing: { kind: "systemEvent", text: "before" },
    patch: structuredClone(commandPayload),
    expected: commandPayload,
  },
  {
    label: "command to script with execution limits",
    existing: { kind: "command", argv: ["echo", "before"] },
    patch: { kind: "script", script: "return {};", timeoutSeconds: 30, toolBudget: 5 },
    expected: { kind: "script", script: "return {};", timeoutSeconds: 30, toolBudget: 5 },
  },
  {
    label: "installs a newly stamped default marker on command",
    existing: { kind: "command", argv: ["echo", "before"] },
    patch: { kind: "command", toolsAllow: ["read", "cron"], toolsAllowIsDefault: true },
    expected: {
      kind: "command",
      argv: ["echo", "before"],
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
  },
  {
    label: "clears toolsAllow explicitly across a kind change",
    existing: { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "agentTurn", message: "after", toolsAllow: null },
    expected: { kind: "agentTurn", message: "after" },
  },
  {
    label: "preserves default-cap provenance across a kind change",
    existing: {
      kind: "systemEvent",
      text: "before",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
    patch: { kind: "agentTurn", message: "after" },
    expected: {
      kind: "agentTurn",
      message: "after",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
  },
] satisfies MergeCase[];

it.each(mergeCases)("$label", ({ existing, patch, expected }) => {
  expect(mergeCronPayload(existing, patch)).toEqual(expected);
});
