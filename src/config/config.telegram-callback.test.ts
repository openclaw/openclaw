import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("telegram callback schema", () => {
  it("accepts callback direct mode configuration", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          callback: {
            enabled: true,
            tapIntercept: true,
            forwardUnhandled: false,
            dedupeWindowMs: 3000,
            buttonStateMode: "mark-clicked",
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.callback).toEqual({
      enabled: true,
      tapIntercept: true,
      forwardUnhandled: false,
      dedupeWindowMs: 3000,
      buttonStateMode: "mark-clicked",
    });
  });

  it("rejects invalid callback button state mode", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          callback: {
            buttonStateMode: "invalid",
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts buttonStateMode off", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          callback: {
            enabled: true,
            buttonStateMode: "off",
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }
    expect(res.data.channels?.telegram?.callback?.buttonStateMode).toBe("off");
  });

  it("accepts buttonStateMode disable-clicked", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          callback: {
            enabled: true,
            buttonStateMode: "disable-clicked",
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }
    expect(res.data.channels?.telegram?.callback?.buttonStateMode).toBe("disable-clicked");
  });

  it("rejects forwardUnhandled=false without enabled=true", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          callback: {
            forwardUnhandled: false,
          },
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }
    const messages = res.error.issues.map((i) => i.message);
    expect(messages).toContain(
      "callback.forwardUnhandled=false requires callback.enabled=true to take effect",
    );
  });

  it("accepts forwardUnhandled=false with enabled=true", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          callback: {
            enabled: true,
            forwardUnhandled: false,
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });
});
