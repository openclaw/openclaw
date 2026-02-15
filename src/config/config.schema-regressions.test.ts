import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
  it("accepts Signal action toggles for unsend and poll lifecycle actions", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          actions: {
            reactions: true,
            poll: true,
            unsend: true,
            pollVote: true,
            pollClose: true,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.config.channels?.signal?.actions?.poll).toBe(true);
    expect(res.config.channels?.signal?.actions?.unsend).toBe(true);
    expect(res.config.channels?.signal?.actions?.pollVote).toBe(true);
    expect(res.config.channels?.signal?.actions?.pollClose).toBe(true);
  });

  it("accepts nested telegram groupPolicy overrides", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              groupPolicy: "open",
              topics: {
                "42": {
                  groupPolicy: "disabled",
                },
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it('accepts memorySearch fallback "voyage"', () => {
    const res = validateConfigObject({
      agents: {
        defaults: {
          memorySearch: {
            fallback: "voyage",
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
