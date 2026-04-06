import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("HeartbeatSchema setTimeout overflow validation", () => {
  it("rejects heartbeat.every exceeding Node.js setTimeout limit", () => {
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          defaults: {
            heartbeat: { every: "99999h" },
          },
        },
      }),
    ).toThrow(/setTimeout limit/i);
  });

  it("accepts heartbeat.every within setTimeout limit", () => {
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          defaults: {
            heartbeat: { every: "596h" },
          },
        },
      }),
    ).not.toThrow();
  });

  it("accepts typical heartbeat.every values", () => {
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          defaults: {
            heartbeat: { every: "30m" },
          },
        },
      }),
    ).not.toThrow();
  });

  it("still rejects invalid duration syntax", () => {
    expect(() =>
      OpenClawSchema.parse({
        agents: {
          defaults: {
            heartbeat: { every: "abc" },
          },
        },
      }),
    ).toThrow(/invalid duration/i);
  });
});
