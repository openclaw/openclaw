import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { CronAddParamsSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import {
  CI_AUTOMATION_OPTIONS,
  ciAutomationDeclarationPrefix,
  ciAutomationJobMatches,
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "./session-pr-automation-spec.ts";

const target: CiAutomationTarget = {
  sessionKey: "agent:main:dashboard:task-a",
  sessionId: "session-a",
  agentId: "main",
  owner: "openclaw",
  repo: "openclaw",
  number: 123,
};

function message(option: CiAutomationOption): string {
  const payload = ciAutomationJobSpec(target, option).payload;
  if (payload.kind !== "agentTurn") {
    throw new Error("PR automation must run an agent turn");
  }
  return payload.message;
}

describe("PR automation recipes", () => {
  it("bounds declaration keys and separates every ownership dimension and action", () => {
    const prefix = ciAutomationDeclarationPrefix(target);
    expect(ciAutomationDeclarationPrefix({ ...target })).toBe(prefix);
    expect(ciAutomationDeclarationPrefix({ ...target, owner: "OpenClaw", repo: "OpenClaw" })).toBe(
      prefix,
    );
    const variants: CiAutomationTarget[] = [
      { ...target, agentId: "other" },
      { ...target, sessionKey: "agent:main:dashboard:task-b" },
      { ...target, sessionId: "replacement-session" },
      { ...target, owner: "other" },
      { ...target, repo: "other" },
      { ...target, number: 124 },
    ];
    const prefixes = [prefix, ...variants.map(ciAutomationDeclarationPrefix)];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    const keys = CI_AUTOMATION_OPTIONS.map((option) =>
      ciAutomationJobSpec({ ...target, sessionKey: "long-session:".repeat(200) }, option),
    ).map((job) => job.declarationKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).toMatch(/^session-pr:v1:[a-f0-9]{64}:auto(?:Fix|Merge|Archive)$/u);
      expect(key?.length).toBeLessThanOrEqual(200);
    }
  });

  it("uses an unambiguous tuple rather than concatenating target identifiers", () => {
    expect(ciAutomationDeclarationPrefix({ ...target, owner: "a:b", repo: "c" })).not.toBe(
      ciAutomationDeclarationPrefix({ ...target, owner: "a", repo: "b:c" }),
    );
  });

  it.each(CI_AUTOMATION_OPTIONS)("binds %s to its intended execution owner", (option) => {
    const job = ciAutomationJobSpec(target, option);
    expect(Value.Check(CronAddParamsSchema, job)).toBe(true);
    expect(job).toMatchObject({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      owner: { agentId: target.agentId, sessionKey: target.sessionKey },
      enabled: true,
      sessionTarget: option === "autoArchive" ? "isolated" : `session:${target.sessionKey}`,
      schedule: { kind: "every", everyMs: 300_000 },
      payload: { kind: "agentTurn" },
      delivery: { mode: "none" },
    });
    expect(ciAutomationJobMatches(job, target, option)).toBe(true);
    for (const other of CI_AUTOMATION_OPTIONS.filter((value) => value !== option)) {
      expect(ciAutomationJobMatches(job, target, other)).toBe(false);
    }
  });

  it("rejects retargeted or unowned rows even if their declaration key was copied", () => {
    const job = ciAutomationJobSpec(target, "autoFix");
    const mismatches = [
      { ...job, agentId: "other" },
      { ...job, sessionKey: "agent:main:other" },
      { ...job, owner: undefined },
      { ...job, owner: { agentId: "other", sessionKey: target.sessionKey } },
      { ...job, owner: { agentId: target.agentId, sessionKey: "agent:main:other" } },
      { ...job, sessionTarget: "isolated" as const },
      { ...job, declarationKey: undefined },
      { ...job, payload: { kind: "systemEvent" as const, text: "not an agent turn" } },
    ];
    for (const mismatch of mismatches) {
      expect(ciAutomationJobMatches(mismatch, target, "autoFix")).toBe(false);
    }
    expect(ciAutomationJobMatches(job, { ...target, number: 124 }, "autoFix")).toBe(false);
    expect(
      ciAutomationJobMatches(job, { ...target, sessionId: "replacement-session" }, "autoFix"),
    ).toBe(false);
    const archive = ciAutomationJobSpec(target, "autoArchive");
    expect(
      ciAutomationJobMatches(
        { ...archive, sessionTarget: `session:${target.sessionKey}` },
        target,
        "autoArchive",
      ),
    ).toBe(false);
  });

  it("recognizes disabled jobs without treating editable prompt text as settings", () => {
    const job = {
      ...ciAutomationJobSpec(target, "autoFix"),
      enabled: false,
      name: "User-edited label",
      payload: { kind: "agentTurn" as const, message: "User-edited instructions" },
    };
    expect(ciAutomationJobMatches(job, target, "autoFix")).toBe(true);
  });

  it("separates repair, landing, and guarded archive instructions", () => {
    for (const option of CI_AUTOMATION_OPTIONS) {
      expect(message(option)).toContain(JSON.stringify(target.sessionId));
      expect(message(option)).toContain("never adopt the replacement session");
    }
    expect(message("autoFix")).toContain("must not merge or close the PR");
    const merge = message("autoMerge");
    expect(merge).toContain("must not fix code or comments");
    expect(merge).toContain("A passing CI rollup alone is not readiness");
    const archive = message("autoArchive");
    expect(archive).toContain("expectedSessionId set to the captured sessionId above");
    expect(archive).toContain(
      "If a repair or other work is active, defer rather than interrupt it",
    );
    expect(archive).toContain("A scheduled or uncertain result is not confirmed archive");
  });
});
