import { describe, expect, it } from "vitest";
import {
  buildSystemdManagedDropIn,
  buildSystemdUnit,
  OPENCLAW_MANAGED_DROPIN_FILENAME,
  OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR,
  parseSystemdEnvAssignments,
  splitSystemdManagedEnvironment,
  stripEnvironmentKeysFromSystemdUnit,
  stripManagedEnvFromSystemdUnit,
  updateEnvironmentFilesInSystemdUnit,
  updateExecStartInSystemdUnit,
  updateWorkingDirectoryInSystemdUnit,
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
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("TimeoutStartSec=30");
    expect(unit).toContain("SuccessExitStatus=0 143");
    expect(unit).toContain("StartLimitBurst=5");
    expect(unit).toContain("StartLimitIntervalSec=60");
    expect(unit).toContain("RestartPreventExitStatus=78");
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

  it("excludes managed env from the main unit when the sentinel is present", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: {
        OPENCLAW_GATEWAY_TOKEN: "managed-token",
        OPENCLAW_SERVICE_VERSION: "2026.4.12",
        [OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR]: "OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
        USER_ADDED_KEY: "keep-me",
      },
    });
    expect(unit).not.toContain("OPENCLAW_GATEWAY_TOKEN=");
    expect(unit).not.toContain("OPENCLAW_SERVICE_VERSION=");
    expect(unit).not.toContain(OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR);
    expect(unit).toContain("Environment=USER_ADDED_KEY=keep-me");
  });

  it("keeps all env inline when no sentinel is present", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaw Gateway",
      programArguments: ["/usr/bin/openclaw", "gateway", "run"],
      environment: { FOO: "bar", BAZ: "qux" },
    });
    expect(unit).toContain("Environment=FOO=bar");
    expect(unit).toContain("Environment=BAZ=qux");
  });
});

describe("splitSystemdManagedEnvironment", () => {
  it("partitions managed vs user by the sentinel list", () => {
    const { managed, user } = splitSystemdManagedEnvironment({
      OPENCLAW_GATEWAY_TOKEN: "token",
      OPENCLAW_SERVICE_VERSION: "v",
      [OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR]: "OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
      HOME: "/home/test",
      USER_ADDED: "x",
    });
    expect(managed).toEqual({
      OPENCLAW_GATEWAY_TOKEN: "token",
      OPENCLAW_SERVICE_VERSION: "v",
      [OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR]: "OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
    });
    expect(user).toEqual({ HOME: "/home/test", USER_ADDED: "x" });
  });

  it("treats all env as user when no sentinel is present", () => {
    const { managed, user } = splitSystemdManagedEnvironment({ FOO: "bar" });
    expect(managed).toEqual({});
    expect(user).toEqual({ FOO: "bar" });
  });

  it("handles undefined and empty input", () => {
    expect(splitSystemdManagedEnvironment(undefined)).toEqual({ managed: {}, user: {} });
    expect(splitSystemdManagedEnvironment({})).toEqual({ managed: {}, user: {} });
  });

  it("matches managed keys case-insensitively against the sentinel", () => {
    const { managed, user } = splitSystemdManagedEnvironment({
      openclaw_gateway_token: "lower",
      OPENCLAW_GATEWAY_TOKEN: "upper",
      [OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR]: "OPENCLAW_GATEWAY_TOKEN",
    });
    expect(managed.OPENCLAW_GATEWAY_TOKEN).toBe("upper");
    expect(managed.openclaw_gateway_token).toBe("lower");
    expect(user).toEqual({});
  });
});

describe("buildSystemdManagedDropIn", () => {
  it("emits a [Service] block with only managed env", () => {
    const text = buildSystemdManagedDropIn({
      OPENCLAW_GATEWAY_TOKEN: "token",
      OPENCLAW_SERVICE_VERSION: "2026.4.12",
      [OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR]: "OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
      HOME: "/home/test",
    });
    expect(text).toContain("# Auto-managed by openclaw.");
    expect(text).toContain("[Service]");
    expect(text).toContain("Environment=OPENCLAW_GATEWAY_TOKEN=token");
    expect(text).toContain("Environment=OPENCLAW_SERVICE_VERSION=2026.4.12");
    expect(text).toContain(
      `Environment=${OPENCLAW_MANAGED_SERVICE_ENV_KEYS_VAR}=OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION`,
    );
    // Non-managed entries stay out.
    expect(text).not.toContain("Environment=HOME=");
  });

  it("returns an empty string when there is nothing to manage", () => {
    expect(buildSystemdManagedDropIn(undefined)).toBe("");
    expect(buildSystemdManagedDropIn({})).toBe("");
    expect(buildSystemdManagedDropIn({ FOO: "bar" })).toBe("");
  });

  it("uses the stable drop-in filename in documentation-relevant constants", () => {
    expect(OPENCLAW_MANAGED_DROPIN_FILENAME).toBe("openclaw-managed.conf");
  });
});

describe("stripManagedEnvFromSystemdUnit", () => {
  const UNIT_WITH_INLINE_MANAGED = [
    "[Unit]",
    "Description=OpenClaw Gateway (v2026.4.11)",
    "",
    "[Service]",
    "ExecStart=/usr/bin/node /home/user/openclaw/dist/entry.js gateway --port 18789",
    "Restart=always",
    "Environment=OPENCLAW_GATEWAY_TOKEN=managed-token",
    "Environment=TELEGRAM_BOT_TOKEN=managed-tg",
    "EnvironmentFile=/home/user/.openclaw/workspace/.env",
    "Environment=HOME=/home/user",
    "Environment=PATH=/usr/bin:/bin",
    "Environment=OPENCLAW_SERVICE_VERSION=2026.4.11",
    "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN,TELEGRAM_BOT_TOKEN,OPENCLAW_SERVICE_VERSION",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  it("removes managed Environment= lines and the sentinel itself", () => {
    const stripped = stripManagedEnvFromSystemdUnit(UNIT_WITH_INLINE_MANAGED);
    expect(stripped).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=");
    expect(stripped).not.toContain("Environment=TELEGRAM_BOT_TOKEN=");
    expect(stripped).not.toContain("Environment=OPENCLAW_SERVICE_VERSION=");
    expect(stripped).not.toContain("OPENCLAW_SERVICE_MANAGED_ENV_KEYS=");
  });

  it("preserves user-added EnvironmentFile= and unmanaged Environment= lines", () => {
    const stripped = stripManagedEnvFromSystemdUnit(UNIT_WITH_INLINE_MANAGED);
    expect(stripped).toContain("EnvironmentFile=/home/user/.openclaw/workspace/.env");
    expect(stripped).toContain("Environment=HOME=/home/user");
    expect(stripped).toContain("Environment=PATH=/usr/bin:/bin");
  });

  it("preserves ExecStart, [Unit], [Install], and blank lines", () => {
    const stripped = stripManagedEnvFromSystemdUnit(UNIT_WITH_INLINE_MANAGED);
    expect(stripped).toContain(
      "ExecStart=/usr/bin/node /home/user/openclaw/dist/entry.js gateway --port 18789",
    );
    expect(stripped).toContain("[Unit]");
    expect(stripped).toContain("[Install]");
    expect(stripped).toContain("WantedBy=default.target");
    expect(stripped).toContain("Restart=always");
  });

  it("returns the input unchanged when there is no sentinel", () => {
    const text = "[Service]\nExecStart=/bin/true\nEnvironment=FOO=bar\n";
    expect(stripManagedEnvFromSystemdUnit(text)).toBe(text);
  });

  it("leaves unmanaged Environment= lines that happen to share a prefix with managed keys", () => {
    const text = [
      "[Service]",
      "ExecStart=/bin/true",
      "Environment=OPENCLAW_GATEWAY_TOKEN=managed",
      "Environment=OPENCLAW_GATEWAY_TOKEN_BACKUP=user-copy",
      "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN",
      "",
    ].join("\n");
    const stripped = stripManagedEnvFromSystemdUnit(text);
    expect(stripped).not.toContain("Environment=OPENCLAW_GATEWAY_TOKEN=managed");
    expect(stripped).toContain("Environment=OPENCLAW_GATEWAY_TOKEN_BACKUP=user-copy");
  });

  it("strips managed assignments from multi-assignment Environment lines", () => {
    const text = [
      "[Service]",
      "ExecStart=/bin/true",
      'Environment="OPENCLAW_GATEWAY_TOKEN=managed token" "HOME=/home/user" "OPENCLAW_SERVICE_VERSION=2026.4.14"',
      "Environment=OPENCLAW_SERVICE_MANAGED_ENV_KEYS=OPENCLAW_GATEWAY_TOKEN,OPENCLAW_SERVICE_VERSION",
      "",
    ].join("\n");

    const stripped = stripManagedEnvFromSystemdUnit(text);

    expect(stripped).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(stripped).not.toContain("OPENCLAW_SERVICE_VERSION");
    expect(stripped).not.toContain("OPENCLAW_SERVICE_MANAGED_ENV_KEYS");
    expect(stripped).toContain("Environment=HOME=/home/user");
  });
});

describe("parseSystemdEnvAssignments", () => {
  it("parses quoted multi-assignment Environment values", () => {
    expect(parseSystemdEnvAssignments('"A=one two" "B=three"')).toEqual([
      { key: "A", value: "one two" },
      { key: "B", value: "three" },
    ]);
  });

  it("unescapes quoted backslashes and quotes", () => {
    expect(parseSystemdEnvAssignments('"A=C:\\\\Tools\\\\OpenClaw" "B=quoted\\\"value"')).toEqual([
      { key: "A", value: "C:\\Tools\\OpenClaw" },
      { key: "B", value: 'quoted"value' },
    ]);
  });
});

describe("stripEnvironmentKeysFromSystemdUnit", () => {
  it("removes dotenv-backed keys while keeping other assignments on the same line", () => {
    const text = [
      "[Service]",
      'Environment="OPENCLAW_GATEWAY_TOKEN=from-dotenv" "HOME=/home/user"',
      "",
    ].join("\n");

    const stripped = stripEnvironmentKeysFromSystemdUnit(text, ["OPENCLAW_GATEWAY_TOKEN"]);

    expect(stripped).not.toContain("OPENCLAW_GATEWAY_TOKEN");
    expect(stripped).toContain("Environment=HOME=/home/user");
  });
});

describe("updateEnvironmentFilesInSystemdUnit", () => {
  it("adds missing EnvironmentFile entries to an existing Service section", () => {
    const text = [
      "[Unit]",
      "Description=OpenClaw Gateway",
      "",
      "[Service]",
      "ExecStart=/usr/bin/openclaw gateway run",
      "KillMode=control-group",
      "Environment=HOME=/home/user",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");

    const result = updateEnvironmentFilesInSystemdUnit(text, [
      "/home/user/.openclaw/gateway.systemd.env",
    ]);

    expect(result.updated).toBe(true);
    expect(text).not.toContain("EnvironmentFile=");
    expect(result.text).toContain("EnvironmentFile=-/home/user/.openclaw/gateway.systemd.env");
    expect(result.text.indexOf("KillMode=control-group")).toBeLessThan(
      result.text.indexOf("EnvironmentFile=-/home/user/.openclaw/gateway.systemd.env"),
    );
    expect(
      result.text.indexOf("EnvironmentFile=-/home/user/.openclaw/gateway.systemd.env"),
    ).toBeLessThan(result.text.indexOf("Environment=HOME=/home/user"));
  });
});

describe("updateExecStartInSystemdUnit", () => {
  const BASE_UNIT = [
    "[Unit]",
    "Description=OpenClaw Gateway",
    "",
    "[Service]",
    "ExecStart=/usr/bin/node /home/user/openclaw/dist/entry.js gateway --port 18789",
    "Restart=always",
    "Environment=HOME=/home/user",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  it("updates only the ExecStart line when the entry path has drifted", () => {
    const { text, updated, found } = updateExecStartInSystemdUnit(BASE_UNIT, [
      "/usr/bin/node",
      "/home/user/openclaw/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ]);
    expect(found).toBe(true);
    expect(updated).toBe(true);
    expect(text).toContain(
      "ExecStart=/usr/bin/node /home/user/openclaw/dist/index.js gateway --port 18789",
    );
    expect(text).not.toContain("dist/entry.js");
    expect(text).toContain("Environment=HOME=/home/user");
    expect(text).toContain("Description=OpenClaw Gateway");
    expect(text).toContain("[Install]");
  });

  it("returns updated=false when the ExecStart already matches", () => {
    const { text, updated, found } = updateExecStartInSystemdUnit(BASE_UNIT, [
      "/usr/bin/node",
      "/home/user/openclaw/dist/entry.js",
      "gateway",
      "--port",
      "18789",
    ]);
    expect(found).toBe(true);
    expect(updated).toBe(false);
    expect(text).toBe(BASE_UNIT);
  });

  it("reports found=false when the unit has no ExecStart line", () => {
    const textWithoutExecStart = BASE_UNIT.replace(
      "ExecStart=/usr/bin/node /home/user/openclaw/dist/entry.js gateway --port 18789\n",
      "",
    );
    const { text, updated, found } = updateExecStartInSystemdUnit(textWithoutExecStart, [
      "/usr/bin/node",
      "/home/user/openclaw/dist/index.js",
      "gateway",
      "--port",
      "18789",
    ]);
    expect(found).toBe(false);
    expect(updated).toBe(false);
    expect(text).toBe(textWithoutExecStart);
  });
});

describe("updateWorkingDirectoryInSystemdUnit", () => {
  const BASE_UNIT = [
    "[Unit]",
    "Description=OpenClaw Gateway",
    "",
    "[Service]",
    "ExecStart=/usr/bin/node /home/user/openclaw/dist/index.js gateway --port 18789",
    "Restart=always",
    "KillMode=control-group",
    "Environment=HOME=/home/user",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  it("updates an existing WorkingDirectory line in place", () => {
    const input = BASE_UNIT.replace(
      "Environment=HOME=/home/user",
      "WorkingDirectory=/old/worktree\nEnvironment=HOME=/home/user",
    );
    const { text, updated } = updateWorkingDirectoryInSystemdUnit(input, "/new/worktree");
    expect(updated).toBe(true);
    expect(text).toContain("WorkingDirectory=/new/worktree");
    expect(text).not.toContain("WorkingDirectory=/old/worktree");
    expect(text).toContain("Environment=HOME=/home/user");
  });

  it("inserts WorkingDirectory after KillMode when missing", () => {
    const { text, updated } = updateWorkingDirectoryInSystemdUnit(BASE_UNIT, "/new/worktree");
    expect(updated).toBe(true);
    expect(text).toContain("WorkingDirectory=/new/worktree");
    expect(text.indexOf("KillMode=control-group")).toBeLessThan(
      text.indexOf("WorkingDirectory=/new/worktree"),
    );
    expect(text.indexOf("WorkingDirectory=/new/worktree")).toBeLessThan(
      text.indexOf("Environment=HOME=/home/user"),
    );
  });

  it("removes a stale WorkingDirectory line when no working directory is configured", () => {
    const input = BASE_UNIT.replace(
      "Environment=HOME=/home/user",
      "WorkingDirectory=/old/worktree\nEnvironment=HOME=/home/user",
    );
    const { text, updated } = updateWorkingDirectoryInSystemdUnit(input, undefined);
    expect(updated).toBe(true);
    expect(text).not.toContain("WorkingDirectory=");
    expect(text).toContain("Environment=HOME=/home/user");
  });
});
