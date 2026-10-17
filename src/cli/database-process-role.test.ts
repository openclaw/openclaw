import { describe, expect, it } from "vitest";
import { resolveCliDatabaseProcessRole } from "./database-process-role.js";

describe("CLI database process role", () => {
  it.each([
    [[], "gateway"],
    [["gateway"], "gateway"],
    [["--profile", "test", "gateway", "run"], "gateway"],
    [["gateway", "status"], "cli-oneshot"],
    [["onboard"], "gateway"],
    [["onboard", "--classic"], "gateway"],
    [["onboard", "--classic", "--flow", "quickstart"], "gateway"],
    [["onboard", "--workspace", "recommendations"], "gateway"],
    [["setup"], "gateway"],
    [["setup", "--wizard", "--mode", "local"], "gateway"],
    [["crestodian"], "gateway"],
    [["setup", "--baseline"], "cli-oneshot"],
    [["onboard", "--non-interactive"], "cli-oneshot"],
    [["setup", "--non-interactive"], "cli-oneshot"],
    [["onboard", "recommendations"], "cli-oneshot"],
    [["onboard", "--json", "recommendations"], "cli-oneshot"],
    [["onboard", "--help"], "cli-oneshot"],
    [["models", "list"], "cli-oneshot"],
    [["agents", "add"], "cli-oneshot"],
    [["config", "set"], "cli-oneshot"],
    [["--update"], "cli-oneshot"],
    [["doctor", "--fix"], "cli-oneshot"],
  ])("classifies %j as %s before state access", (args, expected) => {
    expect(resolveCliDatabaseProcessRole(["node", "openclaw", ...args])).toBe(expected);
  });
});
