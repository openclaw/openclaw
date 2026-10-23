import { describe, expect, it } from "vitest";
import { parseLaunchctlJob } from "./launchd-job-parser.js";

describe("launchd update compatibility observation", () => {
  it("parses only the selected job root while retaining runtime and environment blocks", () => {
    const target = "gui/501/ai.openclaw.gateway";
    const parsed = parseLaunchctlJob(
      [
        `${target} = {`,
        "\tpath = /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist",
        "\tstate = running",
        "\tpid = 4321",
        "\tlast exit status = 0",
        "\tlast exit reason = clean",
        "\tprogram = /usr/bin/node",
        "\targuments = {",
        "\t\t/usr/bin/node",
        "\t\t/opt/openclaw/dist/index.js",
        "\t}",
        "\tinherited environment = {",
        "\t\tPATH => /usr/bin",
        "\t}",
        "\tenvironment = {",
        "\t\tOPENCLAW_SERVICE_MARKER => openclaw",
        "\t}",
        "\tchild = {",
        "\t\tstate = stopped",
        "\t\tpid = 99",
        "\t}",
        "}",
      ].join("\n"),
      target,
    );

    expect(parsed.runtime).toEqual({
      state: "running",
      pid: 4321,
      lastExitStatus: 0,
      lastExitReason: "clean",
    });
    expect(parsed.arguments).toEqual(["/usr/bin/node", "/opt/openclaw/dist/index.js"]);
    expect(parsed.environment).toContain("OPENCLAW_SERVICE_MARKER => openclaw");
    expect(parsed.environmentBlocks).toContain("PATH => /usr/bin");
    expect(parsed.fields.get("pid")).toBe("4321");
  });

  it("rejects a reply for another launchd target", () => {
    expect(() => parseLaunchctlJob("gui/501/other = {\n}", "gui/501/expected")).toThrow(
      "Cannot parse launchd job gui/501/expected",
    );
  });
});
