import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/test-api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { resolveSystemdRecoveryPermission, testing } from "./doctor-gateway-startup-recovery.js";

const tempRoots = useAutoCleanupTempDirTracker(afterEach);

it("isolates doctor commands from host lifecycle, credentials, and target overrides", () => {
  const accountHome = path.join("/home", "qa-account");
  const inherited = {
    OPENCLAW_GATEWAY_PORT: "28789",
    OPENCLAW_GATEWAY_TOKEN: "host-token",
    OPENCLAW_GATEWAY_URL: "wss://ambient.example.invalid",
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
    OPENCLAW_SUPERVISOR_MODE: "external",
    SUDO_COMMAND: "/usr/bin/sudo openclaw doctor",
    SUDO_GID: "1000",
    SUDO_UID: "1000",
    SUDO_USER: "ambient-admin",
  };
  const env = testing.commandEnv(
    "qa-doctor-policy",
    {
      HOME: "/tmp/sandbox-home",
      ...inherited,
      OPENCLAW_CONFIG_PATH: "/tmp/host-config.json",
      OPENCLAW_STATE_DIR: "/tmp/host-state",
      PATH: "/usr/bin",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/999/bus",
      XDG_RUNTIME_DIR: "/run/user/999",
    },
    accountHome,
    1001,
  );

  expect(env).toMatchObject({
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1001/bus",
    HOME: accountHome,
    OPENCLAW_CONFIG_PATH: path.join(accountHome, ".openclaw-qa-doctor-policy", "openclaw.json"),
    OPENCLAW_PROFILE: "qa-doctor-policy",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_STATE_DIR: path.join(accountHome, ".openclaw-qa-doctor-policy"),
    PATH: "/usr/bin",
    XDG_RUNTIME_DIR: "/run/user/1001",
  });
  for (const key of Object.keys(inherited)) {
    expect(env[key], key).toBeUndefined();
  }
});

it("requires an explicit native-systemd opt-in", () => {
  expect(resolveSystemdRecoveryPermission({})).toEqual({
    available: false,
    reason:
      "blocked native systemd recovery proof; set OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY=1 on a prepared host",
  });
  expect(resolveSystemdRecoveryPermission({ OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY: "1" })).toEqual({
    available: true,
  });
});

it("writes honest blocked evidence before native execution is enabled", async () => {
  const artifactBase = path.join(tempRoots.make("openclaw-doctor-systemd-"), "artifacts");

  const evidence = await testing.runProducer({ artifactBase, repoRoot: process.cwd() }, {});

  expect(evidence.entries[0]?.result.status).toBe("blocked");
  const diskEvidence = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(path.join(artifactBase, QA_EVIDENCE_FILENAME), "utf8")),
  );
  expect(diskEvidence.entries[0]?.result).toMatchObject({
    failure: {
      reason: expect.stringContaining("OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY=1"),
    },
    status: "blocked",
  });
  await expect(
    fs.readFile(path.join(artifactBase, "doctor-gateway-startup-recovery.log"), "utf8"),
  ).resolves.toContain("blocked native systemd recovery proof");
});
