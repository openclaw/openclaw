import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectMarkerLineWithGateway, findExtraGatewayServices } from "./inspect.js";

const { execSchtasksMock } = vi.hoisted(() => ({
  execSchtasksMock: vi.fn(),
}));

vi.mock("./schtasks-exec.js", () => ({
  execSchtasks: (...args: unknown[]) => execSchtasksMock(...args),
}));

// Real content from the mullusi-gateway.service unit file (the canonical gateway unit).
const GATEWAY_SERVICE_CONTENTS = `\
[Unit]
Description=Mullusi Gateway (v2026.3.8)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/mullusi/.npm-global/lib/node_modules/mullusi/dist/entry.js gateway --port 18790
Restart=always
Environment=MULLUSI_SERVICE_MARKER=mullusi
Environment=MULLUSI_SERVICE_KIND=gateway
Environment=MULLUSI_SERVICE_VERSION=2026.3.8

[Install]
WantedBy=default.target
`;

// Real content from the mullusi-test.service unit file (a non-gateway mullusi service).
const TEST_SERVICE_CONTENTS = `\
[Unit]
Description=Mullusi test service
After=default.target

[Service]
Type=simple
ExecStart=/bin/sh -c 'while true; do sleep 60; done'
Restart=on-failure

[Install]
WantedBy=default.target
`;

const CLAWDBOT_GATEWAY_CONTENTS = `\
[Unit]
Description=Mullusi Gateway
[Service]
ExecStart=/usr/bin/node /opt/mullusi/dist/entry.js gateway --port 18790
Environment=HOME=/home/mullusi
`;

describe("detectMarkerLineWithGateway", () => {
  it("returns null for mullusi-test.service (mullusi only in description, no gateway on same line)", () => {
    expect(detectMarkerLineWithGateway(TEST_SERVICE_CONTENTS)).toBeNull();
  });

  it("returns mullusi for the canonical gateway unit (ExecStart has both mullusi and gateway)", () => {
    expect(detectMarkerLineWithGateway(GATEWAY_SERVICE_CONTENTS)).toBe("mullusi");
  });

  it("returns mullusi for a mullusi gateway unit", () => {
    expect(detectMarkerLineWithGateway(CLAWDBOT_GATEWAY_CONTENTS)).toBe("mullusi");
  });

  it("handles line continuations — marker and gateway split across physical lines", () => {
    const contents = `[Service]\nExecStart=/usr/bin/node /opt/mullusi/dist/entry.js \\\n  gateway --port 18790\n`;
    expect(detectMarkerLineWithGateway(contents)).toBe("mullusi");
  });
});

describe("findExtraGatewayServices (linux / scanSystemdDir) — real filesystem", () => {
  // These tests write real .service files to a temp dir and call findExtraGatewayServices
  // with that dir as HOME. No platform mocking or fs mocking needed.
  // Only runs on Linux/macOS where the linux branch of findExtraGatewayServices is active.
  const isLinux = process.platform === "linux";

  it.skipIf(!isLinux)("does not report mullusi-test.service as a gateway service", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mullusi-test-"));
    const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
    try {
      await fs.mkdir(systemdDir, { recursive: true });
      await fs.writeFile(path.join(systemdDir, "mullusi-test.service"), TEST_SERVICE_CONTENTS);
      const result = await findExtraGatewayServices({ HOME: tmpHome });
      expect(result).toEqual([]);
    } finally {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it.skipIf(!isLinux)(
    "does not report the canonical mullusi-gateway.service as an extra service",
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mullusi-test-"));
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      try {
        await fs.mkdir(systemdDir, { recursive: true });
        await fs.writeFile(
          path.join(systemdDir, "mullusi-gateway.service"),
          GATEWAY_SERVICE_CONTENTS,
        );
        const result = await findExtraGatewayServices({ HOME: tmpHome });
        expect(result).toEqual([]);
      } finally {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!isLinux)(
    "reports a legacy mullusi-gateway service as an extra gateway service",
    async () => {
      const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "mullusi-test-"));
      const systemdDir = path.join(tmpHome, ".config", "systemd", "user");
      const unitPath = path.join(systemdDir, "mullusi-gateway.service");
      try {
        await fs.mkdir(systemdDir, { recursive: true });
        await fs.writeFile(unitPath, CLAWDBOT_GATEWAY_CONTENTS);
        const result = await findExtraGatewayServices({ HOME: tmpHome });
        expect(result).toEqual([
          {
            platform: "linux",
            label: "mullusi-gateway.service",
            detail: `unit: ${unitPath}`,
            scope: "user",
            marker: "mullusi",
            legacy: true,
          },
        ]);
      } finally {
        await fs.rm(tmpHome, { recursive: true, force: true });
      }
    },
  );
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

  it("collects only non-mullusi marker tasks from schtasks output", async () => {
    execSchtasksMock.mockResolvedValueOnce({
      code: 0,
      stdout: [
        "TaskName: Mullusi Gateway",
        "Task To Run: C:\\Program Files\\Mullusi\\mullusi.exe gateway run",
        "",
        "TaskName: Mullusi Legacy",
        "Task To Run: C:\\mullusi\\mullusi.exe run",
        "",
        "TaskName: Other Task",
        "Task To Run: C:\\tools\\helper.exe",
        "",
      ].join("\n"),
      stderr: "",
    });

    const result = await findExtraGatewayServices({}, { deep: true });
    expect(result).toEqual([
      {
        platform: "win32",
        label: "Mullusi Legacy",
        detail: "task: Mullusi Legacy, run: C:\\mullusi\\mullusi.exe run",
        scope: "system",
        marker: "mullusi",
        legacy: true,
      },
    ]);
  });
});
