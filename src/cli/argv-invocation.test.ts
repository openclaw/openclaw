// Argv invocation tests cover CLI argv normalization before command dispatch.
import { describe, expect, it } from "vitest";
import { resolveCliArgvInvocation } from "./argv-invocation.js";

describe("argv-invocation", () => {
  it("resolves root help and empty command path", () => {
    expect(resolveCliArgvInvocation(["node", "openclaw", "--help"])).toEqual({
      argv: ["node", "openclaw", "--help"],
      commandPath: [],
      primary: null,
      hasHelpOrVersion: true,
      isRootHelpInvocation: true,
    });
  });

  it("resolves command path and primary with root options", () => {
    expect(
      resolveCliArgvInvocation(["node", "openclaw", "--profile", "work", "gateway", "status"]),
    ).toEqual({
      argv: ["node", "openclaw", "--profile", "work", "gateway", "status"],
      commandPath: ["gateway", "status"],
      primary: "gateway",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });

  it.each([
    {
      args: ["models", "--status-json"],
      commandPath: ["models"],
    },
    {
      args: ["models", "--agent", "main", "--status-json"],
      commandPath: ["models"],
    },
    {
      args: ["models", "--status-json", "--agent", "main"],
      commandPath: ["models"],
    },
    {
      args: ["models", "--agent=main", "--status-json"],
      commandPath: ["models"],
    },
    {
      args: ["models", "--agent", "main", "status", "--json"],
      commandPath: ["models", "status"],
    },
    {
      args: ["models", "--agent=main", "status", "--json"],
      commandPath: ["models", "status"],
    },
  ])("resolves parent model options for $args", ({ args, commandPath }) => {
    const argv = ["node", "openclaw", ...args];

    expect(resolveCliArgvInvocation(argv)).toEqual({
      argv,
      commandPath,
      primary: "models",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });
});
