import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("signal accountUuid schema", () => {
  it("accepts channels.signal.accountUuid", () => {
    const res = validateConfigObject({
      channels: {
        signal: {
          dmPolicy: "open",
          allowFrom: ["*"],
          accountUuid: "00000000-0000-0000-0000-000000000001",
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
