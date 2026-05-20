import { describe, expect, it } from "vitest";
import { FLAG_TERMINATOR } from "../infra/cli-root-options.js";
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

  it("stops command path resolution at the shared flag terminator", () => {
    const argv = ["node", "openclaw", "status", FLAG_TERMINATOR, "ignored", "--help"];
    expect(resolveCliArgvInvocation(argv)).toEqual({
      argv,
      commandPath: ["status"],
      primary: "status",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });
});
