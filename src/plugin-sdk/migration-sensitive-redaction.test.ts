import { describe, expect, it } from "vitest";
import {
  createMigrationConfigPatchItem,
  redactMigrationPlan,
  redactMigrationValue,
  summarizeMigrationItems,
} from "./migration.js";

describe("migration sensitive value redaction", () => {
  it("redacts array cycles while retaining repeated non-cyclic array values", () => {
    const cyclic: unknown[] = ["visible"];
    cyclic.push(cyclic);
    const repeated = ["visible"];

    expect(redactMigrationValue({ cyclic, repeated: [repeated, repeated] })).toEqual({
      cyclic: ["visible", "[redacted]"],
      repeated: [["visible"], ["visible"]],
    });
  });

  it("masks positional values inside sensitive config items", () => {
    const item = createMigrationConfigPatchItem({
      id: "config:mcp-positional-value",
      target: "mcp.servers.example",
      path: ["mcp", "servers"],
      value: { example: { command: "server", args: ["--value", "opaque-positional-placeholder"] } },
      message: "Import MCP server.",
      sensitive: true,
    });
    const redacted = redactMigrationPlan({
      providerId: "hermes",
      source: "fixture",
      summary: summarizeMigrationItems([item]),
      items: [item],
    });

    expect(JSON.stringify(redacted)).not.toContain("opaque-positional-placeholder");
    expect(redacted.items[0]?.details?.value).toBe("[redacted]");
  });
});
