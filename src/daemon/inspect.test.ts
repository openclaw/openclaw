import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findExtraGatewayServices } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

function pathLikeToString(p: unknown): string {
  if (typeof p === "string") {
    return p;
  }
  if (p instanceof URL) {
    return p.pathname;
  }
  if (p instanceof Uint8Array) {
    return Buffer.from(p).toString("utf8");
  }
  return "";
}

// Normalize to forward slashes so virtual fs keys are consistent on all platforms.
// inspect.ts uses path.join internally (which uses \ on Windows), but the Linux
// paths it constructs (/etc/systemd/system, ~/.config/systemd/user) are always
// semantically forward-slash paths — normalizing lets the spy match them correctly.
function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

// Real content from the openclaw-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw Gateway (v2026.3.8)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/openclaw/.npm-global/lib/node_modules/openclaw/dist/entry.js gateway --port 18789
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group
Environment=HOME=/home/openclaw
Environment=TMPDIR=/tmp
Environment=PATH=/home/openclaw/.local/bin:/home/openclaw/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
Environment=OPENCLAW_GATEWAY_PORT=18789
Environment=OPENCLAW_SYSTEMD_UNIT=openclaw-gateway.service
Environment="OPENCLAW_WINDOWS_TASK_NAME=OpenClaw Gateway"
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway
Environment=OPENCLAW_SERVICE_VERSION=2026.3.8

[Install]
WantedBy=default.target
`;

// Real content from the openclaw-test.service unit file (a non-gateway openclaw service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=OpenClaw test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

describe("findExtraGatewayServices (linux / scanSystemdDir)", () => {
  const HOME = "/home/testuser";
  const USER_SYSTEMD_DIR = "/home/testuser/.config/systemd/user";
  let originalPlatform: string;
  let files: Map<string, string>;

  beforeEach(() => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "linux",
    });
    files = new Map();
    vi.spyOn(fs, "readdir").mockImplementation(async (dir) => {
      const prefix = toForwardSlash(pathLikeToString(dir));
      const withSep = prefix.endsWith("/") ? prefix : prefix + "/";
      const names: string[] = [];
      for (const key of files.keys()) {
        const rest = key.slice(withSep.length);
        if (key.startsWith(withSep) && !rest.includes("/")) {
          names.push(rest);
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return names as any;
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (filePath) => {
      const p = toForwardSlash(pathLikeToString(filePath));
      const contents = files.get(p);
      if (contents === undefined) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return contents as any;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  function addUnit(name: string, contents: string, dir = USER_SYSTEMD_DIR) {
    files.set(`${dir}/${name}`, contents);
  }

  it("returns empty results when the systemd user dir is empty", async () => {
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([]);
  });

  it("does not report the canonical openclaw-gateway.service unit as an extra service", async () => {
    // The gateway unit is the one we install; it must be silently skipped.
    addUnit("openclaw-gateway.service", GATEWAY_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([]);
  });

  it("does not report openclaw-test.service as a gateway service (no gateway marker line)", async () => {
    // This service mentions openclaw in its Description but has no gateway-related line,
    // so detectMarkerLineWithGateway should return null and it must be ignored.
    addUnit("openclaw-test.service", TEST_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([]);
  });

  it("does not report an unrelated service with no openclaw marker", async () => {
    addUnit(
      "some-other.service",
      `[Unit]\nDescription=Some unrelated service\n[Service]\nExecStart=/usr/bin/foo\n`,
    );
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([]);
  });

  it("reports a legacy clawdbot-gateway service as an extra gateway service", async () => {
    const contents = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
Environment=HOME=/home/clawdbot
`;
    addUnit("clawdbot-gateway.service", contents);
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([
      {
        platform: "linux",
        label: "clawdbot-gateway.service",
        detail: `unit: ${USER_SYSTEMD_DIR}/clawdbot-gateway.service`,
        scope: "user",
        marker: "clawdbot",
        legacy: true,
      },
    ]);
  });

  it("does not report a profiled openclaw gateway service (openclaw-gateway-<profile>) as an extra service", async () => {
    // A profiled gateway unit (name starts with "openclaw-gateway") is recognized as a
    // first-party gateway and must be silently skipped, not reported as extra.
    const contents = `\
[Unit]
Description=OpenClaw Gateway (profile: work)
[Service]
ExecStart=/usr/bin/node /home/openclaw/.npm-global/lib/node_modules/openclaw/dist/entry.js gateway --port 18790
Environment=OPENCLAW_SERVICE_MARKER=openclaw
Environment=OPENCLAW_SERVICE_KIND=gateway
[Install]
WantedBy=default.target
`;
    addUnit("openclaw-gateway-work.service", contents);
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([]);
  });

  it("reports an openclaw service whose name does not start with openclaw-gateway as an extra service", async () => {
    // A unit that mentions openclaw+gateway on the same line but has a non-gateway name
    // is reported as an extra service (e.g. a user-managed wrapper).
    const contents = `\
[Unit]
Description=My openclaw gateway wrapper
[Service]
ExecStart=/usr/local/bin/openclaw-gateway-wrapper --port 18790
[Install]
WantedBy=default.target
`;
    addUnit("my-openclaw-wrapper.service", contents);
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([
      {
        platform: "linux",
        label: "my-openclaw-wrapper.service",
        detail: `unit: ${USER_SYSTEMD_DIR}/my-openclaw-wrapper.service`,
        scope: "user",
        marker: "openclaw",
        legacy: false,
      },
    ]);
  });

  it("ignores non-.service files in the systemd dir", async () => {
    addUnit("openclaw-gateway.conf", GATEWAY_SERVICE_CONTENTS);
    const result = await findExtraGatewayServices({ HOME });
    expect(result).toEqual([]);
  });

  it("keeps separate entries for the same unit filename appearing in different scanned dirs (deep mode)", async () => {
    const SYSTEM_DIR = "/etc/systemd/system";
    const contents = `\
[Unit]
Description=Clawdbot Gateway
[Service]
ExecStart=/usr/bin/node /opt/clawdbot/dist/entry.js gateway --port 18789
`;
    addUnit("clawdbot-gateway.service", contents, USER_SYSTEMD_DIR);
    addUnit("clawdbot-gateway.service", contents, SYSTEM_DIR);

    const result = await findExtraGatewayServices({ HOME }, { deep: true });
    // Same label+detail+scope combination from different dirs → two distinct entries
    // (different detail paths), but neither should be the canonical gateway.
    expect(result.every((s) => s.marker === "clawdbot")).toBe(true);
    expect(result.length).toBe(2);
  });
});

describe("findExtraGatewayServices (win32)", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    execSchtasksMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("skips schtasks queries unless deep mode is enabled", async () => {
    const result = await findExtraGatewayServices({});
    expect(result).toEqual([]);
    expect(execSchtasksMock).not.toHaveBeenCalled();
  });

  it("returns empty results when schtasks query fails", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "error",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([]);
  });

  it("collects only non-openclaw marker tasks from schtasks output", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: OpenClaw Gateway",
        "Task To Run: C:\\Program Files\\OpenClaw\\openclaw.exe gateway run",
        "",
        "TaskName: Clawdbot Legacy",
        "Task To Run: C:\\clawdbot\\clawdbot.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
        "TaskName: MoltBot Legacy",
        "Task To Run: C:\\moltbot\\moltbot.exe run",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Clawdbot Legacy",
        detail: "task: Clawdbot Legacy, run: C:\\clawdbot\\clawdbot.exe run",
        scope: "system",
        marker: "clawdbot",
        legacy: true,
      },
      {
        platform: "win32",
        label: "MoltBot Legacy",
        detail: "task: MoltBot Legacy, run: C:\\moltbot\\moltbot.exe run",
        scope: "system",
        marker: "moltbot",
        legacy: true,
      },
    ]);
  });
});
