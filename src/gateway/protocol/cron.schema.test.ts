import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import { CronDeliverySchema } from "./schema/cron.js";

describe("CronDeliverySchema (#73017)", () => {
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const validate = new Ajv({ strict: false }).compile(CronDeliverySchema);

  it("accepts threadId as a string on announce delivery", () => {
    expect(
      validate({
        mode: "announce",
        channel: "telegram",
        to: "123456789",
        threadId: "topic-42",
      }),
    ).toBe(true);
  });

  it("accepts threadId as a number on announce delivery", () => {
    expect(
      validate({
        mode: "announce",
        channel: "telegram",
        to: "123456789",
        threadId: 42,
      }),
    ).toBe(true);
  });

  it("accepts threadId on noop and webhook variants", () => {
    expect(validate({ mode: "none", threadId: "thr" })).toBe(true);
    expect(
      validate({
        mode: "webhook",
        to: "https://example.test/hook",
        threadId: 7,
      }),
    ).toBe(true);
  });

  it("still rejects truly unexpected properties (additionalProperties:false invariant preserved)", () => {
    expect(
      validate({
        mode: "announce",
        channel: "telegram",
        to: "123",
        bogusField: true,
      }),
    ).toBe(false);
  });
});
