import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/test-api.js";
import { resolveSystemdRecoveryPermission, testing } from "./doctor-gateway-startup-recovery.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("doctor gateway startup recovery producer", () => {
  it("isolates doctor commands from host lifecycle, credentials, and target overrides", () => {
    const accountHome = path.join("/home", "qa-account");
    const env = testing.commandEnv(
      "qa-doctor-policy",
      {
        HOME: "/tmp/sandbox-home",
        OPENCLAW_CONFIG_PATH: "/tmp/host-config.json",
        OPENCLAW_GATEWAY_PORT: "28789",
        OPENCLAW_GATEWAY_TOKEN: "host-token",
        OPENCLAW_GATEWAY_URL: "wss://ambient.example.invalid",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_STATE_DIR: "/tmp/host-state",
        OPENCLAW_SUPERVISOR_MODE: "external",
        PATH: "/usr/bin",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/999/bus",
        SUDO_COMMAND: "/usr/bin/sudo openclaw doctor",
        SUDO_GID: "1000",
        SUDO_UID: "1000",
        SUDO_USER: "ambient-admin",
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
    expect(env.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_PORT).toBeUndefined();
    expect(env.OPENCLAW_GATEWAY_URL).toBeUndefined();
    expect(env.OPENCLAW_SERVICE_REPAIR_POLICY).toBeUndefined();
    expect(env.OPENCLAW_SUPERVISOR_MODE).toBeUndefined();
    expect(env.SUDO_COMMAND).toBeUndefined();
    expect(env.SUDO_GID).toBeUndefined();
    expect(env.SUDO_UID).toBeUndefined();
    expect(env.SUDO_USER).toBeUndefined();
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-systemd-"));
    const artifactBase = path.join(root, "artifacts");
    tempRoots.push(root);

    const evidence = await testing.runProducer(
      {
        artifactBase,
        repoRoot: process.cwd(),
      },
      {},
    );

    expect(evidence.entries[0]?.result.status).toBe("blocked");
    const diskEvidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(artifactBase, QA_EVIDENCE_FILENAME), "utf8")),
    );
    expect(diskEvidence.entries[0]).toMatchObject({
      result: {
        failure: {
          reason: expect.stringContaining("OPENCLAW_QA_ALLOW_SYSTEMD_RECOVERY=1"),
        },
        status: "blocked",
      },
    });
    await expect(
      fs.readFile(path.join(artifactBase, "doctor-gateway-startup-recovery.log"), "utf8"),
    ).resolves.toContain("blocked native systemd recovery proof");
  });
});
