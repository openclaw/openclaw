import { describe, expect, it } from "vitest";
import { buildLaunchAgentPlist } from "./launchd-plist.js";

describe("buildLaunchAgentPlist", () => {
  it("uses KeepAlive.SuccessfulExit + ThrottleInterval=5", () => {
    const plist = buildLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments: ["/usr/bin/node", "gateway"],
      stdoutPath: "/tmp/openclaw.out.log",
      stderrPath: "/tmp/openclaw.err.log",
    });

    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>");
    expect(plist).toContain("<integer>5</integer>");
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\s*\/>/i);
  });
});
