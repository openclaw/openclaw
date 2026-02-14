import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("gateway.remote.transport", () => {
  it("accepts direct transport", () => {
    const res = validateConfigObject({
      gateway: {
        remote: {
          transport: "direct",
          url: "wss://gateway.example.ts.net",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects unknown transport", () => {
    const res = validateConfigObject({
      gateway: {
        remote: {
          transport: "udp",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("gateway.remote.transport");
    }
  });
});
