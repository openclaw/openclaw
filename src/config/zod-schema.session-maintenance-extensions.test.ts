import { describe, expect, it } from "vitest";
import { SessionSchema } from "./zod-schema.session.js";

describe("SessionSchema maintenance extensions", () => {
  it("preserves valid maintenance extensions", () => {
    const maintenance = {
      preserveRecent: "7d",
      resetArchiveRetention: "14d",
      maxDiskBytes: "500mb",
      highWaterBytes: "350mb",
      coldStorage: { enabled: true, afterDays: 30 },
    };
    expect(SessionSchema.parse({ maintenance })?.maintenance).toEqual(maintenance);
  });

  it("accepts disabling the session disk budget", () => {
    expect(SessionSchema.safeParse({ maintenance: { maxDiskBytes: false } }).success).toBe(true);
  });

  it("accepts disabling dashboard archiving with zero", () => {
    expect(SessionSchema.safeParse({ maintenance: { archiveDashboardAfter: 0 } }).success).toBe(
      true,
    );
  });

  it.each([
    ["preserveRecent", "forever"],
    ["resetArchiveRetention", "0d"],
    ["maxDiskBytes", "big"],
    ["highWaterBytes", "-0.4b"],
  ])("reports invalid %s maintenance values", (key, value) => {
    const result = SessionSchema.safeParse({ maintenance: { [key]: value } });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toContain(key);
  });

  it("accepts highWaterBytes that round down to zero", () => {
    expect(SessionSchema.safeParse({ maintenance: { highWaterBytes: "0.4b" } }).success).toBe(true);
  });
});
