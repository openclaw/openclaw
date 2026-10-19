import { describe, expect, it } from "vitest";
import type { CronPayload, CronPayloadPatch } from "../types.js";
import { mergeCronPayload } from "./payload-merge.js";

type MergeCase = {
  label: string;
  existing: CronPayload;
  patch: CronPayloadPatch;
  expected: CronPayload;
};

const preserveCases = [
  {
    label: "systemEvent",
    existing: { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", text: "after" },
    expected: { kind: "systemEvent", text: "after", toolsAllow: ["read", "cron"] },
  },
] satisfies MergeCase[];

const updateCases = [
  {
    label: "systemEvent",
    existing: { kind: "systemEvent", text: "tick", toolsAllow: ["read", "cron"] },
    patch: { kind: "systemEvent", toolsAllow: ["cron"] },
    expected: { kind: "systemEvent", text: "tick", toolsAllow: ["cron"] },
  },
] satisfies MergeCase[];

const kindChangeCases = [
  {
    label: "agentTurn to command",
    existing: { kind: "agentTurn", message: "before", toolsAllow: ["read", "cron"] },
    patch: { kind: "command", argv: ["echo", "after"] },
    expected: { kind: "command", argv: ["echo", "after"], toolsAllow: ["read", "cron"] },
  },
  {
    label: "systemEvent to agentTurn with overrides",
    existing: { kind: "systemEvent", text: "before" },
    patch: {
      kind: "agentTurn",
      message: "after",
      model: "provider/model",
      fallbacks: ["provider/fallback"],
      thinking: "high",
      timeoutSeconds: 30,
      lightContext: true,
      allowUnsafeExternalContent: false,
    },
    expected: {
      kind: "agentTurn",
      message: "after",
      model: "provider/model",
      fallbacks: ["provider/fallback"],
      thinking: "high",
      timeoutSeconds: 30,
      lightContext: true,
      allowUnsafeExternalContent: false,
    },
  },
  {
    label: "systemEvent to command with execution settings",
    existing: { kind: "systemEvent", text: "before" },
    patch: {
      kind: "command",
      argv: ["echo", "after"],
      cwd: "/synthetic-workspace",
      env: { SYNTHETIC: "yes" },
      input: "stdin",
      timeoutSeconds: 30,
      noOutputTimeoutSeconds: 5,
      outputMaxBytes: 1024,
    },
    expected: {
      kind: "command",
      argv: ["echo", "after"],
      cwd: "/synthetic-workspace",
      env: { SYNTHETIC: "yes" },
      input: "stdin",
      timeoutSeconds: 30,
      noOutputTimeoutSeconds: 5,
      outputMaxBytes: 1024,
    },
  },
  {
    label: "command to script with execution limits",
    existing: { kind: "command", argv: ["echo", "before"] },
    patch: { kind: "script", script: "return {};", timeoutSeconds: 30, toolBudget: 5 },
    expected: { kind: "script", script: "return {};", timeoutSeconds: 30, toolBudget: 5 },
  },
] satisfies MergeCase[];

const installDefaultMarkerCases = [
  {
    label: "command",
    existing: { kind: "command", argv: ["echo", "before"] },
    patch: { kind: "command", toolsAllow: ["read", "cron"], toolsAllowIsDefault: true },
    expected: {
      kind: "command",
      argv: ["echo", "before"],
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    },
  },
] satisfies MergeCase[];

describe("mergeCronPayload trigger tool caps", () => {
  it.each(preserveCases)(
    "preserves $label toolsAllow when omitted",
    ({ existing, patch, expected }) => {
      expect(mergeCronPayload(existing, patch)).toEqual(expected);
    },
  );

  it.each(updateCases)("updates $label toolsAllow", ({ existing, patch, expected }) => {
    expect(mergeCronPayload(existing, patch)).toEqual(expected);
  });

  it.each(kindChangeCases)(
    "preserves toolsAllow across $label",
    ({ existing, patch, expected }) => {
      expect(mergeCronPayload(existing, patch)).toEqual(expected);
    },
  );

  it.each(installDefaultMarkerCases)(
    "installs a newly stamped default marker on $label",
    ({ existing, patch, expected }) => {
      expect(mergeCronPayload(existing, patch)).toEqual(expected);
    },
  );

  it("clears toolsAllow explicitly across a kind change", () => {
    expect(
      mergeCronPayload(
        { kind: "systemEvent", text: "before", toolsAllow: ["read", "cron"] },
        { kind: "agentTurn", message: "after", toolsAllow: null },
      ),
    ).toEqual({ kind: "agentTurn", message: "after" });
  });

  it("preserves default-cap provenance across a kind change", () => {
    expect(
      mergeCronPayload(
        {
          kind: "systemEvent",
          text: "before",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        },
        { kind: "agentTurn", message: "after" },
      ),
    ).toEqual({
      kind: "agentTurn",
      message: "after",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    });
  });
});
