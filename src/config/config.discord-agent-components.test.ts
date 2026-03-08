import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("discord agentComponents config", () => {
  it("accepts channels.discord.agentComponents.enabled", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          agentComponents: {
            enabled: true,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts channels.discord.accounts.<id>.agentComponents.enabled", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          accounts: {
            work: {
              agentComponents: {
                enabled: false,
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown fields under channels.discord.agentComponents", () => {
    const res = validateConfigObject({
      channels: {
        discord: {
          agentComponents: {
            enabled: true,
            invalidField: true,
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(
        res.issues.some(
          (issue) =>
            issue.path === "channels.discord.agentComponents" &&
            issue.message.toLowerCase().includes("unrecognized"),
        ),
      ).toBe(true);
    }
  });
});
