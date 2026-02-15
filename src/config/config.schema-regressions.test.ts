import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("config schema regressions", () => {
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

  it('accepts gateway.bind="custom" with gateway.customBindHost', () => {
    const res = validateConfigObject({
      gateway: {
        bind: "custom",
        customBindHost: "192.168.1.100",
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.gateway?.bind).toBe("custom");
      expect(res.config.gateway?.customBindHost).toBe("192.168.1.100");
    }
  });
});
