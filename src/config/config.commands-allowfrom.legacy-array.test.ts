import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("commands.allowFrom legacy array", () => {
  it("accepts legacy array form and coerces to global '*' allowlist record", () => {
    const res = validateConfigObject({
      commands: {
        allowFrom: ["discordid"],
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.commands?.allowFrom).toEqual({ "*": ["discordid"] });
    }
  });

  it("rejects legacy array form when entries are not strings/numbers", () => {
    const res = validateConfigObject({
      commands: {
        // @ts-expect-error test invalid shape
        allowFrom: [{ bad: true }],
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.path === "commands.allowFrom.*.0")).toBe(true);
    }
  });
});
