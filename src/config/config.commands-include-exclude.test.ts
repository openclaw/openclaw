import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./config.js";
import { OpenClawSchema } from "./zod-schema.js";

describe("commands.include / commands.exclude", () => {
  it("schema accepts both include and exclude without error", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          commands: {
            include: ["start", "help"],
            exclude: ["debug"],
          },
        },
      },
    });
    expect(res.success).toBe(true);
  });

  it("emits warning (not error) when both include and exclude are set", () => {
    const res = validateConfigObjectWithPlugins({
      channels: {
        telegram: {
          commands: {
            include: ["start", "help"],
            exclude: ["debug"],
          },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(
      res.warnings.some(
        (w) =>
          w.path === "channels.telegram.commands.exclude" &&
          w.message.includes("mutually exclusive"),
      ),
    ).toBe(true);
  });

  it("no warning when only include is set", () => {
    const res = validateConfigObjectWithPlugins({
      channels: {
        telegram: {
          commands: { include: ["start"] },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings.some((w) => w.path.includes("commands.exclude"))).toBe(false);
  });

  it("no warning when only exclude is set", () => {
    const res = validateConfigObjectWithPlugins({
      channels: {
        telegram: {
          commands: { exclude: ["debug"] },
        },
      },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) {
      return;
    }
    expect(res.warnings.some((w) => w.path.includes("commands.exclude"))).toBe(false);
  });
});
