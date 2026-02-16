import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { splitArgsPreservingQuotes } from "./arg-split.js";
import {
  isSystemdUserServiceAvailable,
  parseSystemdShow,
  readSystemdServiceExecStart,
  resolveSystemdUserUnitPath,
} from "./systemd.js";
import { parseSystemdExecStart } from "./systemd-unit.js";

describe("systemd availability", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("returns true when systemctl --user succeeds", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(true);
  });

  it("returns false when systemd user bus is unavailable", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      const err = new Error("Failed to connect to bus") as Error & {
        stderr?: string;
        code?: number;
      };
      err.stderr = "Failed to connect to bus";
      err.code = 1;
      cb(err, "", "");
    });
    await expect(isSystemdUserServiceAvailable()).resolves.toBe(false);
  });
});

describe("systemd runtime parsing", () => {
  it("parses active state details", () => {
    const output = [
      "ActiveState=inactive",
      "SubState=dead",
      "MainPID=0",
      "ExecMainStatus=2",
      "ExecMainCode=exited",
    ].join("\n");
    expect(parseSystemdShow(output)).toEqual({
      activeState: "inactive",
      subState: "dead",
      execMainStatus: 2,
      execMainCode: "exited",
    });
  });
});

describe("resolveSystemdUserUnitPath", () => {
  it("uses default service name when OPENCLAW_PROFILE is unset", () => {
    const env = { HOME: "/home/test" };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/openclaw-gateway.service",
    );
  });

  it("uses profile-specific service name when OPENCLAW_PROFILE is set to a custom value", () => {
    const env = { HOME: "/home/test", OPENCLAW_PROFILE: "jbphoenix" };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/openclaw-gateway-jbphoenix.service",
    );
  });

  it("prefers OPENCLAW_SYSTEMD_UNIT over OPENCLAW_PROFILE", () => {
    const env = {
      HOME: "/home/test",
      OPENCLAW_PROFILE: "jbphoenix",
      OPENCLAW_SYSTEMD_UNIT: "custom-unit",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/custom-unit.service",
    );
  });

  it("handles OPENCLAW_SYSTEMD_UNIT with .service suffix", () => {
    const env = {
      HOME: "/home/test",
      OPENCLAW_SYSTEMD_UNIT: "custom-unit.service",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/custom-unit.service",
    );
  });

  it("trims whitespace from OPENCLAW_SYSTEMD_UNIT", () => {
    const env = {
      HOME: "/home/test",
      OPENCLAW_SYSTEMD_UNIT: "  custom-unit  ",
    };
    expect(resolveSystemdUserUnitPath(env)).toBe(
      "/home/test/.config/systemd/user/custom-unit.service",
    );
  });
});

describe("splitArgsPreservingQuotes", () => {
  it("splits on whitespace outside quotes", () => {
    expect(splitArgsPreservingQuotes('/usr/bin/openclaw gateway start --name "My Bot"')).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });

  it("supports systemd-style backslash escaping", () => {
    expect(
      splitArgsPreservingQuotes('openclaw --name "My \\"Bot\\"" --foo bar', {
        escapeMode: "backslash",
      }),
    ).toEqual(["openclaw", "--name", 'My "Bot"', "--foo", "bar"]);
  });

  it("supports schtasks-style escaped quotes while preserving other backslashes", () => {
    expect(
      splitArgsPreservingQuotes('openclaw --path "C:\\\\Program Files\\\\OpenClaw"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["openclaw", "--path", "C:\\\\Program Files\\\\OpenClaw"]);

    expect(
      splitArgsPreservingQuotes('openclaw --label "My \\"Quoted\\" Name"', {
        escapeMode: "backslash-quote-only",
      }),
    ).toEqual(["openclaw", "--label", 'My "Quoted" Name']);
  });
});

describe("parseSystemdExecStart", () => {
  it("preserves quoted arguments", () => {
    const execStart = '/usr/bin/openclaw gateway start --name "My Bot"';
    expect(parseSystemdExecStart(execStart)).toEqual([
      "/usr/bin/openclaw",
      "gateway",
      "start",
      "--name",
      "My Bot",
    ]);
  });
});

describe("readSystemdServiceExecStart with EnvironmentFile and drop-ins", () => {
  it("includes env from EnvironmentFile= in returned environment", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-env-"));
    try {
      const userDir = path.join(tmpDir, ".config", "systemd", "user");
      await fs.mkdir(userDir, { recursive: true });
      const unitPath = path.join(userDir, "openclaw-gateway.service");
      const secretsDir = path.join(tmpDir, "secrets");
      await fs.mkdir(secretsDir, { recursive: true });
      const envFilePath = path.join(secretsDir, "agent1.env");
      await fs.writeFile(
        envFilePath,
        "# comment\nOPENCLAW_GATEWAY_TOKEN=from-env-file\nOTHER_VAR=ok\n",
        "utf8",
      );
      const unitContent = [
        "[Unit]",
        "Description=OpenClaw Gateway",
        "[Service]",
        "ExecStart=/usr/bin/openclaw gateway run --port 18789",
        `EnvironmentFile=${envFilePath}`,
        "[Install]",
        "WantedBy=default.target",
      ].join("\n");
      await fs.writeFile(unitPath, unitContent, "utf8");

      const env = { HOME: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readSystemdServiceExecStart(env);
      expect(result).not.toBeNull();
      expect(result?.environment).toEqual({
        OPENCLAW_GATEWAY_TOKEN: "from-env-file",
        OTHER_VAR: "ok",
      });
      expect(result?.programArguments).toEqual(["/usr/bin/openclaw", "gateway", "run", "--port", "18789"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("merges drop-in EnvironmentFile= and later overrides earlier", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-dropin-"));
    try {
      const userDir = path.join(tmpDir, ".config", "systemd", "user");
      await fs.mkdir(userDir, { recursive: true });
      const unitPath = path.join(userDir, "openclaw-gateway.service");
      const dropInDir = path.join(userDir, "openclaw-gateway.service.d");
      await fs.mkdir(dropInDir, { recursive: true });
      const env1 = path.join(tmpDir, "first.env");
      const env2 = path.join(tmpDir, "second.env");
      await fs.writeFile(env1, "TOKEN=first\n", "utf8");
      await fs.writeFile(env2, "TOKEN=second\nOPENCLAW_CONFIG_PATH=/etc/openclaw/config.json\n", "utf8");

      await fs.writeFile(
        unitPath,
        [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          `EnvironmentFile=${env1}`,
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(dropInDir, "secrets.conf"),
        `[Service]\nEnvironmentFile=${env2}\n`,
        "utf8",
      );

      const env = { HOME: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readSystemdServiceExecStart(env);
      expect(result?.environment).toEqual({
        TOKEN: "second",
        OPENCLAW_CONFIG_PATH: "/etc/openclaw/config.json",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips optional EnvironmentFile= (-/path) when file is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-optional-"));
    try {
      const userDir = path.join(tmpDir, ".config", "systemd", "user");
      await fs.mkdir(userDir, { recursive: true });
      const unitPath = path.join(userDir, "openclaw-gateway.service");
      const missingPath = path.join(tmpDir, "missing.env");

      await fs.writeFile(
        unitPath,
        [
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          `EnvironmentFile=-${missingPath}`,
        ].join("\n"),
        "utf8",
      );

      const env = { HOME: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readSystemdServiceExecStart(env);
      expect(result).not.toBeNull();
      expect(result?.programArguments).toEqual(["/usr/bin/openclaw", "gateway", "run"]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses only [Service] section for Environment and EnvironmentFile", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-systemd-section-"));
    try {
      const userDir = path.join(tmpDir, ".config", "systemd", "user");
      await fs.mkdir(userDir, { recursive: true });
      const unitPath = path.join(userDir, "openclaw-gateway.service");
      await fs.writeFile(
        unitPath,
        [
          "[Unit]",
          "Environment=IGNORED=unit",
          "[Service]",
          "ExecStart=/usr/bin/openclaw gateway run",
          "Environment=OPENCLAW_GATEWAY_TOKEN=from-service",
          "[Install]",
          "WantedBy=default.target",
        ].join("\n"),
        "utf8",
      );

      const env = { HOME: tmpDir, OPENCLAW_PROFILE: "default" };
      const result = await readSystemdServiceExecStart(env);
      expect(result?.environment).toEqual({ OPENCLAW_GATEWAY_TOKEN: "from-service" });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
