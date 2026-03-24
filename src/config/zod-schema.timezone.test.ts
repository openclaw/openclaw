import { describe, expect, it } from "vitest";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

describe("timezone schemas", () => {
  it("accepts omitted optional userTimezone values", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        timeFormat: "24",
      }),
    ).not.toThrow();
    expect(() =>
      AgentEntrySchema.parse({
        id: "work",
      }),
    ).not.toThrow();
  });

  it("accepts valid IANA userTimezone values", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        userTimezone: "America/Chicago",
      }),
    ).not.toThrow();
    expect(() =>
      AgentEntrySchema.parse({
        id: "work",
        userTimezone: "America/Los_Angeles",
      }),
    ).not.toThrow();
  });

  it("rejects invalid IANA userTimezone values", () => {
    expect(() =>
      AgentDefaultsSchema.parse({
        userTimezone: "Mars/Olympus",
      }),
    ).toThrow();
    expect(() =>
      AgentEntrySchema.parse({
        id: "work",
        userTimezone: "not-a-timezone",
      }),
    ).toThrow();
  });
});
