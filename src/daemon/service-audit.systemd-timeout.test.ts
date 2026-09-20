import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import "./test-helpers/service-audit-mocks.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import {
  execSystemctlUserMock,
  resetServiceAuditMocks,
} from "./test-helpers/service-audit-fixtures.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("systemd shutdown timeout audit", () => {
  beforeEach(resetServiceAuditMocks);

  it.each([
    { name: "90s manager timeout", base: "330", manager: "1min 30s", expected: true },
    { name: "longer drop-in", base: "90", manager: "5min 30s", expected: false },
    { name: "unlimited manager timeout", base: "90", manager: "infinity", expected: false },
    { name: "legacy unit without a timeout", base: undefined, manager: undefined, expected: true },
    { name: "short base timeout", base: "90s", manager: undefined, expected: true },
    { name: "sufficient base timeout", base: "330", manager: undefined, expected: false },
    {
      name: "base timeout missing cleanup margin",
      base: "329s",
      manager: undefined,
      expected: true,
    },
    { name: "unlimited base timeout", base: "infinity", manager: undefined, expected: false },
    { name: "disabled base timeout", base: "0", manager: undefined, expected: false },
    { name: "invalid base timeout", base: "invalid", manager: undefined, expected: true },
  ])("reports a drain requirement for $name", async ({ base, manager, expected }) => {
    const home = tempDirs.make("openclaw-stop-timeout-audit-");
    const unitPath = path.join(home, ".config/systemd/user/openclaw-gateway.service");
    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.writeFile(
      unitPath,
      [
        "[Unit]",
        "After=network-online.target",
        "Wants=network-online.target",
        "[Service]",
        "ExecStart=/usr/bin/node gateway",
        "RestartSec=5",
        "KillMode=mixed",
        ...(base === undefined ? [] : [`TimeoutStopSec=${base}`]),
      ].join("\n"),
    );
    if (manager !== undefined) {
      execSystemctlUserMock.mockResolvedValueOnce({
        code: 0,
        termination: "exit",
        stderr: "",
        stdout: [
          "LoadState=loaded",
          "After=network-online.target",
          "Wants=network-online.target",
          "RestartUSec=5s",
          "KillMode=mixed",
          `TimeoutStopUSec=${manager}`,
        ].join("\n"),
      });
    }

    const audit = await auditGatewayServiceConfig({
      env: { HOME: home },
      platform: "linux",
      command: null,
    });
    const issue = audit.issues.find((entry) => entry.code === "systemd-stop-timeout");
    expect(Boolean(issue)).toBe(expected);
    if (expected) {
      expect(issue).toMatchObject({
        message: expect.stringContaining("TimeoutStopSec=330"),
        detail: expect.stringContaining(unitPath),
        level: "recommended",
      });
    }
  });
});
