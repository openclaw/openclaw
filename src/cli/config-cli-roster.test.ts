// Config CLI tests cover agent-entry key casing when addressing `agents.entries.<id>`.
import { describe, expect, it } from "vitest";
import { resolveAgentEntryKeyCase } from "./config-cli-roster.js";

const root = {
  agents: { entries: { main: {}, Work: { name: "Work Agent" } } },
} as Record<string, unknown>;

describe("resolveAgentEntryKeyCase", () => {
  it("maps a differently-cased request onto the stored key", () => {
    expect(resolveAgentEntryKeyCase(root, ["agents", "entries", "work", "name"])).toEqual([
      "agents",
      "entries",
      "Work",
      "name",
    ]);
  });

  it("keeps an exact key even when another key differs only by case", () => {
    const ambiguous = { agents: { entries: { work: {}, Work: {} } } } as Record<string, unknown>;

    expect(resolveAgentEntryKeyCase(ambiguous, ["agents", "entries", "work"])).toEqual([
      "agents",
      "entries",
      "work",
    ]);
  });

  it("leaves unmatched and non-agent paths untouched", () => {
    expect(resolveAgentEntryKeyCase(root, ["agents", "entries", "absent"])).toEqual([
      "agents",
      "entries",
      "absent",
    ]);
    expect(resolveAgentEntryKeyCase(root, ["agents", "list", "work"])).toEqual([
      "agents",
      "list",
      "work",
    ]);
  });
});
