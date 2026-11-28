import { describe, expect, it } from "vitest";
import { assertCronBindApplies, resolveCronBindParent } from "./bind-parent.js";
import { createAccountCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import type { CronStoredJob } from "./types.js";

const PARENT = "agent:main:control-ui";
const base = {
  agentId: "main",
  sessionTarget: "isolated",
  payload: { kind: "agentTurn", message: "check" },
} as const satisfies Partial<CronStoredJob>;
const account = createAccountCronScheduledToolPolicy({
  ownerSessionKey: PARENT,
  ownerAccountId: "default",
});
const incarnation = { sessionKey: PARENT, sessionId: "s1", lifecycleRevision: "r1" };

describe("resolveCronBindParent", () => {
  it.each([
    ["account policy naming the parent", { scheduledToolPolicy: account }],
    ["owner key without a policy", { owner: { sessionKey: PARENT } }],
    ["current target", { sessionTarget: "current", scheduledToolPolicy: account }],
    ["default-agent job without agentId", { agentId: undefined, scheduledToolPolicy: account }],
  ])("binds a key-only job: %s", (_name, fields) => {
    expect(resolveCronBindParent({ ...base, ...fields } as CronStoredJob)).toEqual({
      parentSessionKey: PARENT,
    });
  });

  it.each([
    [
      "already bound",
      { scheduledToolPolicy: account, sourceConversation: incarnation },
      /already bound/,
    ],
    [
      "trusted policy",
      { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      /session key alone/,
    ],
    ["no parent key", {}, /session key alone/],
    ["main target", { sessionTarget: "main", scheduledToolPolicy: account }, /main-session/],
  ])("refuses %s", (_name, fields, message) => {
    const result = resolveCronBindParent({ ...base, ...fields } as CronStoredJob);
    expect(result).toEqual({ refusal: expect.stringMatching(message) });
  });

  it("refuses a link for a different parent at the store owner", () => {
    const job = { ...base, scheduledToolPolicy: account } as CronStoredJob;
    expect(() =>
      assertCronBindApplies(job, { ...incarnation, sessionKey: "agent:main:other" }),
    ).toThrow(/not its parent/);
    expect(() => assertCronBindApplies(job, incarnation)).not.toThrow();
  });
});
