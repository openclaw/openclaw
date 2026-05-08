import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema cron run-log validation", () => {
  it("accepts valid cron.runLog values", () => {
    expect(
      OpenClawSchema.safeParse({
        cron: {
          runLog: {
            maxBytes: "5mb",
            keepLines: 2500,
          },
        },
      }),
    ).toMatchObject({ success: true });
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
});
