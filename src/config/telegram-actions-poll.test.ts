import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("telegram poll action config", () => {
  it("accepts channels.telegram.actions.poll", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          actions: {
            poll: false,
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts channels.telegram.accounts.<id>.actions.poll", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          accounts: {
            ops: {
              actions: {
                poll: false,
              },
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
