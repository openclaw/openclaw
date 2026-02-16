import { describe, expect, it } from "vitest";
import { toModelRow } from "./list.registry.js";

describe("toModelRow cli backend behavior", () => {
  it("renders configured cli provider models as non-missing rows", () => {
    const row = toModelRow({
      key: "claude-cli/opus-4.6",
      tags: ["configured"],
      aliases: ["claude"],
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      },
    });

    expect(row.missing).toBe(false);
    expect(row.input).toBe("text");
    expect(row.local).toBe(true);
    expect(row.available).toBe(true);
    expect(row.tags).toContain("cli");
    expect(row.tags).toContain("alias:claude");
  });

  it("keeps unknown non-cli models marked as missing", () => {
    const row = toModelRow({
      key: "example/nonexistent-model",
      tags: ["configured"],
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      },
    });

    expect(row.missing).toBe(true);
    expect(row.tags).toContain("missing");
  });
});
