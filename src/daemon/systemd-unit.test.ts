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

  it("renders control-group kill mode for child-process cleanup", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: {},
    });
    expect(unit).toContain("KillMode=control-group");
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

  it("does not treat escaped trailing backslash as continuation", () => {
    const content = [
      "[Service]",
      "ExecStart=/bin/echo foo\\\\",
      "WorkingDirectory=/home/test",
    ].join("\n");
    expect(collectSystemdExecStartValues(content)).toEqual(["/bin/echo foo\\\\"]);
  });

  it("continues after escaped backslash followed by continuation backslash", () => {
    const content = ["[Service]", "ExecStart=/bin/echo foo\\\\\\", "  bar"].join("\n");
    expect(collectSystemdExecStartValues(content)).toEqual(["/bin/echo foo\\\\ bar"]);
  });

  it("ignores ExecStart keys outside the [Service] section", () => {
    const content = [
      "[Unit]",
      "ExecStart=/snap/bin/chromium --headless --remote-debugging-port=18800",
      "[Service]",
      "ExecStart=/usr/local/bin/helper --mode openclaw",
    ].join("\n");
    expect(collectSystemdExecStartValues(content)).toEqual([
      "/usr/local/bin/helper --mode openclaw",
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

  it("extracts executable token when single-quoted env wrapper is used", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "'env' CHROME_USER_DATA=/tmp/chrome '/snap/bin/chromium' --headless",
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

  it("does not consume executable after env optional signal options", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env --default-signal /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token from env --split-string payload", () => {
    expect(
      extractSystemdExecStartCommandToken(
        '/usr/bin/env --split-string "/snap/bin/chromium --headless --remote-debugging-port=18800"',
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token from env --split-string= payload", () => {
    expect(
      extractSystemdExecStartCommandToken(
        '/usr/bin/env --split-string="/snap/bin/chromium --headless --remote-debugging-port=18800"',
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token from env --split-string= single-quoted payload", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env --split-string='/snap/bin/chromium --headless --user-data-dir=/tmp/openclaw'",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token from env -S inline double-quoted payload", () => {
    expect(
      extractSystemdExecStartCommandToken(
        '/usr/bin/env -S"/snap/bin/chromium --headless --remote-debugging-port=18800"',
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token from env -S inline single-quoted payload", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env -S'/snap/bin/chromium --headless --user-data-dir=/tmp/openclaw'",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when single-quoted env value contains spaces", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env 'CHROME_USER_DATA=/home/user/My Data/openclaw' /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when env uses clustered short options", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env -iu LD_PRELOAD /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when env option value is single-quoted with spaces", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env -C '/home/user/My Data' /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when clustered env option value is single-quoted with spaces", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env -iC '/home/user/My Data' /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when --chdir= inline value is single-quoted with spaces", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env --chdir='/home/user/My Data' /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when --argv0= inline value is single-quoted with spaces", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env --argv0='My Program' /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });

  it("extracts executable token when clustered -C inline value is single-quoted with spaces", () => {
    expect(
      extractSystemdExecStartCommandToken(
        "/usr/bin/env -iC'/home/user/My Data' /snap/bin/chromium --headless",
      ),
    ).toBe("/snap/bin/chromium");
  });
});
