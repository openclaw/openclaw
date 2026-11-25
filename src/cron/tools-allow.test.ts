import { describe, expect, it } from "vitest";
import { createAccountCronScheduledToolPolicy } from "./scheduled-tool-policy.js";
import { cronJobNeedsCreatorReauthorization } from "./tools-allow.js";

describe("cron job creator reauthorization detection", () => {
  const accountPolicy = createAccountCronScheduledToolPolicy({
    ownerSessionKey: "agent:ailybot:telegram:direct:alex",
    ownerAccountId: "ailybot",
  });
  const base = {
    payload: { kind: "agentTurn" as const, toolsAllow: ["exec"] as string[] },
    scheduledToolPolicy: accountPolicy,
    owner: { sessionKey: "agent:ailybot:telegram:direct:alex", accountId: "ailybot" },
  };

  it("flags a DM-key account job with no recorded origin", () => {
    expect(cronJobNeedsCreatorReauthorization({ job: base })).toBe(true);
    expect(
      cronJobNeedsCreatorReauthorization({ job: { ...base, toolsAllowProvenance: undefined } }),
    ).toBe(true);
  });

  it("does not flag a job with a recorded external creator origin", () => {
    expect(
      cronJobNeedsCreatorReauthorization({
        job: {
          ...base,
          toolsAllowProvenance: { callerOrigin: { kind: "external", channel: "telegram" } },
        },
      }),
    ).toBe(false);
  });

  it("does not flag a job with a recorded local creator origin", () => {
    const localOriginJob = {
      ...base,
      toolsAllowProvenance: { callerOrigin: { kind: "local" as const } },
    };
    expect(cronJobNeedsCreatorReauthorization({ job: localOriginJob })).toBe(false);
  });

  it("does not flag a group-key owner (the key resolves a channel)", () => {
    const groupPolicy = createAccountCronScheduledToolPolicy({
      ownerSessionKey: "agent:ailybot:telegram:group:-1004461251264",
      ownerAccountId: "ailybot",
    });
    expect(
      cronJobNeedsCreatorReauthorization({
        job: {
          ...base,
          scheduledToolPolicy: groupPolicy,
          owner: {
            sessionKey: "agent:ailybot:telegram:group:-1004461251264",
            accountId: "ailybot",
          },
        },
      }),
    ).toBe(false);
  });

  it("does not flag trusted-mode jobs or the default account", () => {
    expect(
      cronJobNeedsCreatorReauthorization({
        job: {
          ...base,
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          owner: { sessionKey: "agent:ailybot:telegram:direct:alex", accountId: "ailybot" },
        },
      }),
    ).toBe(false);
    const defaultPolicy = createAccountCronScheduledToolPolicy({
      ownerSessionKey: "agent:main:telegram:direct:alex",
      ownerAccountId: "default",
    });
    expect(
      cronJobNeedsCreatorReauthorization({
        job: {
          ...base,
          scheduledToolPolicy: defaultPolicy,
          owner: { sessionKey: "agent:main:telegram:direct:alex", accountId: "default" },
        },
      }),
    ).toBe(false);
  });

  it("does not flag jobs without a tool cap", () => {
    expect(
      cronJobNeedsCreatorReauthorization({ job: { ...base, payload: { kind: "agentTurn" } } }),
    ).toBe(false);
  });

  it("flags a retained cap only when the job still constructs agent tools", () => {
    const command = { ...base, payload: { kind: "command", argv: ["true"], toolsAllow: ["exec"] } };
    expect(cronJobNeedsCreatorReauthorization({ job: command })).toBe(false);
    expect(
      cronJobNeedsCreatorReauthorization({
        job: { ...command, trigger: { script: "return { fire: false };" } },
      }),
    ).toBe(true);
  });
});
