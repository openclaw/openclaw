import { describe, expect, it } from "vitest";
import { resolveCliDatabaseProcessRole } from "./database-process-role.js";

describe("CLI database process role", () => {
  it.each([
    [[], "gateway"],
    [["--profile", "test"], "gateway"],
    [["--help"], "cli-oneshot"],
    [["gateway"], "gateway"],
    [["--profile", "test", "gateway", "run"], "gateway"],
    [["gateway", "status"], "cli-oneshot"],
    [["onboard"], "cli-oneshot"],
    [["onboard", "--classic"], "cli-oneshot"],
    [["onboard", "--classic", "--flow", "quickstart"], "cli-oneshot"],
    [["onboard", "--workspace", "recommendations"], "cli-oneshot"],
    [["setup"], "cli-oneshot"],
    [["setup", "--wizard", "--mode", "local"], "cli-oneshot"],
    [["crestodian"], "cli-oneshot"],
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
