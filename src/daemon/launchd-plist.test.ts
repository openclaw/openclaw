import { describe, expect, it } from "vitest";
import { buildLaunchAgentPlist } from "./launchd-plist.js";

describe("buildLaunchAgentPlist", () => {
  const basePlist = () =>
    buildLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "start"],
      stdoutPath: "/tmp/stdout.log",
      stderrPath: "/tmp/stderr.log",
    });

  it("includes ExitTimeOut to force-kill unresponsive processes", () => {
    const plist = basePlist();
    expect(plist).toContain("<key>ExitTimeOut</key>");
    expect(plist).toContain("<integer>15</integer>");
  });

  it("includes required plist structure", () => {
    const plist = basePlist();
    expect(plist).toContain('<?xml version="1.0"');
    expect(plist).toContain("<key>Label</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).toContain("<key>ProgramArguments</key>");
  });

  it("escapes special characters in label", () => {
    const plist = buildLaunchAgentPlist({
      label: "ai.openclaw.<test>",
      programArguments: ["/usr/bin/openclaw"],
      stdoutPath: "/tmp/stdout.log",
      stderrPath: "/tmp/stderr.log",
    });
    expect(plist).toContain("ai.openclaw.&lt;test&gt;");
  });

  it("includes WorkingDirectory when provided", () => {
    const plist = buildLaunchAgentPlist({
      label: "ai.openclaw.gateway",
      programArguments: ["/usr/bin/openclaw"],
      workingDirectory: "/home/user",
      stdoutPath: "/tmp/stdout.log",
      stderrPath: "/tmp/stderr.log",
    });
    expect(plist).toContain("<key>WorkingDirectory</key>");
    expect(plist).toContain("/home/user");
  });
});
