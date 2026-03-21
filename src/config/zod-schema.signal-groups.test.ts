import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("signal groups schema", () => {
  it("accepts top-level Signal groups overrides", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          groups: {
            "*": {
              requireMention: false,
            },
            "+1234567890": {
              requireMention: true,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts per-account Signal groups overrides", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          accounts: {
            primary: {
              groups: {
                "*": {
                  requireMention: false,
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("strips unknown keys in Signal groups entries with warnings", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          groups: {
            "*": {
              requireMention: false,
              nope: true,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(
        res.warnings?.some((warning) => warning.path.startsWith("channels.signal.groups")),
      ).toBe(true);
      expect(res.config.channels?.signal?.groups?.["*"]).toEqual({
        requireMention: false,
      });
    }
  });
});
