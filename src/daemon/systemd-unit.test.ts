import { describe, expect, it } from "vitest";
import {
  buildSystemdUnit,
  collectSystemdExecStartValues,
  extractSystemdExecStartCommandToken,
} from "./systemd-unit.js";

describe("buildSystemdUnit", () => {
  it("quotes arguments with whitespace", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "--name", "My Bot"],
      environment: {},
    });
    const execStart = unit.split("\n").find((line) => line.startsWith("ExecStart="));
    expect(execStart).toBe('ExecStart=/usr/bin/openclaw gateway --name "My Bot"');
  });

  it("rejects environment values with line breaks", () => {
    expect(() =>
      buildSystemdUnit({
        description: "OpenClaw Gateway",
        programArguments: ["/usr/bin/openclaw", "gateway", "start"],
        environment: {
          INJECT: "ok\nExecStartPre=/bin/touch /tmp/oc15789_rce",
        },
      }),
    ).toThrow(/CR or LF/);
  });
});

describe("collectSystemdExecStartValues", () => {
  it("collects spaced ExecStart assignments", () => {
    const content = ["[Service]", "ExecStart = /usr/bin/openclaw gateway run"].join("\n");
    expect(collectSystemdExecStartValues(content)).toEqual(["/usr/bin/openclaw gateway run"]);
  });

  it("folds backslash-continued ExecStart lines", () => {
    const content = [
      "[Service]",
      "ExecStart=/usr/bin/env FOO=bar \\",
      "  /snap/bin/chromium --headless --remote-debugging-port=18800",
    ].join("\n");
    expect(collectSystemdExecStartValues(content)).toEqual([
      "/usr/bin/env FOO=bar /snap/bin/chromium --headless --remote-debugging-port=18800",
    ]);
  });
});

describe("extractSystemdExecStartCommandToken", () => {
  it("extracts direct executable command tokens", () => {
    expect(extractSystemdExecStartCommandToken("/usr/bin/openclaw gateway run")).toBe(
      "/usr/bin/openclaw",
    );
  });

  it("extracts executable token when systemd prefix operators are attached", () => {
    expect(extractSystemdExecStartCommandToken("-/snap/bin/chromium --headless")).toBe(
      "/snap/bin/chromium",
    );
  });

  it("extracts executable token when wrapped by env", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env CHROME_USER_DATA=/tmp/chrome /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("skips env option values before picking executable token", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env -u LD_PRELOAD /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });
});
