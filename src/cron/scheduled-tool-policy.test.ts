import { describe, expect, it } from "vitest";
import {
  createAccountCronScheduledToolPolicy,
  cronJobNeedsCreatorReauthorization,
  normalizeCronScheduledToolCallerOrigin,
  normalizeCronScheduledToolPolicy,
  normalizeCronToolsAllowExecTarget,
  normalizeCronToolsAllowExecTargetRequirement,
  resolveCronScheduledToolPolicy,
} from "./scheduled-tool-policy.js";

describe("cron scheduled tool policy", () => {
  it("accepts only the closed current version", () => {
    expect(normalizeCronScheduledToolPolicy({ version: 1, mode: "trusted" })).toEqual({
      version: 1,
      mode: "trusted",
    });
    expect(normalizeCronScheduledToolPolicy({ version: 2, mode: "trusted" })).toBeUndefined();
    expect(
      normalizeCronScheduledToolPolicy({ version: 1, mode: "trusted", ownerAccountId: "work" }),
    ).toBeUndefined();
  });

  it("does not treat inherited authority fields as authored", () => {
    expect(normalizeCronScheduledToolCallerOrigin(Object.create({ kind: "local" }))).toEqual({
      kind: "unknown",
    });
    expect(
      normalizeCronScheduledToolPolicy(Object.create({ version: 1, mode: "trusted" })),
    ).toBeUndefined();
    expect(
      normalizeCronToolsAllowExecTarget(Object.create({ version: 1, host: "gateway" })),
    ).toBeUndefined();
    expect(
      normalizeCronToolsAllowExecTargetRequirement(
        Object.create({
          version: 1,
          target: { version: 1, host: "gateway" },
          grantIndex: 0,
        }),
      ),
    ).toEqual({ version: 1, recoveryRequired: true });
  });

  it("requires account provenance to match the persisted owner", () => {
    const policy = createAccountCronScheduledToolPolicy({
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    });
    expect(
      resolveCronScheduledToolPolicy({
        toolsAllow: ["write"],
        scheduledToolPolicy: policy,
        owner: {
          sessionKey: "agent:main:discord:group:ops",
          accountId: "work",
        },
      }),
    ).toEqual(policy);
    expect(
      resolveCronScheduledToolPolicy({
        toolsAllow: ["write"],
        scheduledToolPolicy: policy,
        owner: {
          sessionKey: "agent:main:discord:group:ops",
          accountId: "personal",
        },
      }),
    ).toBeUndefined();
  });
});

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
});
