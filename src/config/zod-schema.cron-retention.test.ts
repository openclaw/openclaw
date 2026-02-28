import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron/hooks retention and run-log validation", () => {
  it("accepts valid cron.sessionRetention and runLog values", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          sessionRetention: "1h30m",
          runLog: {
            maxBytes: "5mb",
            keepLines: 2500,
          },
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid cron.sessionRetention", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          sessionRetention: "abc",
        },
      }),
    ).toThrow(/sessionRetention|duration/i);
  });

  it("rejects invalid cron.runLog.maxBytes", () => {
    expect(() =>
      OpenClawSchema.parse({
        cron: {
          runLog: {
            maxBytes: "wat",
          },
        },
      }),
    ).toThrow(/runLog|maxBytes|size/i);
  });

  it("accepts valid hooks.sessionRetention", () => {
    expect(() =>
      OpenClawSchema.parse({
        hooks: {
          enabled: true,
          token: "secret",
          sessionRetention: "30m",
        },
      }),
    ).not.toThrow();
  });

  it("accepts hooks.sessionRetention=false", () => {
    expect(() =>
      OpenClawSchema.parse({
        hooks: {
          enabled: true,
          token: "secret",
          sessionRetention: false,
        },
      }),
    ).not.toThrow();
  });

  it("rejects invalid hooks.sessionRetention", () => {
    expect(() =>
      OpenClawSchema.parse({
        hooks: {
          enabled: true,
          token: "secret",
          sessionRetention: "abc",
        },
      }),
    ).toThrow(/sessionRetention|duration/i);
  });
});
