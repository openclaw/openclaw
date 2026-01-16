import { describe, expect, it } from "vitest";

import { parseSystemdExecStart } from "./systemd-unit.js";

describe("parseSystemdExecStart", () => {
  it("splits on whitespace outside quotes", () => {
    const execStart = "/usr/bin/clawdbot gateway start --foo bar";
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/clawdbot",
      "gateway",
      "start",
      "--foo",
      "bar",
    ]);
  });

  it("preserves quoted arguments", () => {
    const execStart = "/usr/bin/clawdbot gateway start --name \"My Bot\"";
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/clawdbot",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("supports backslash-escaped characters", () => {
    const execStart = "/usr/bin/clawdbot gateway start --path \/tmp\/clawdbot";
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/clawdbot",
      "gateway",
      "start",
      "--path",
      "/tmp/clawdbot",
    ]);
  });
});
