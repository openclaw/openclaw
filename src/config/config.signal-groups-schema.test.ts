import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("signal groups config schema", () => {
  it("accepts channels.signal.groups with requireMention", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          dmPolicy: "open",
          allowFrom: ["*"],
          groups: {
            "*": { requireMention: true },
            "group-123": { requireMention: false },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts channels.signal.accounts.*.groups overrides", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          dmPolicy: "open",
          allowFrom: ["*"],
          accounts: {
            work: {
              groups: {
                "*": { requireMention: true, skills: ["calendar"] },
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });
});
