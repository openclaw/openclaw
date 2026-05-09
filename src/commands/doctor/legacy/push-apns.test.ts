import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadApnsRegistration } from "../../../infra/push-apns.js";
import { createTrackedTempDirs } from "../../../test-utils/tracked-temp-dirs.js";
import {
  importLegacyApnsRegistrationFileToSqlite,
  legacyApnsRegistrationFileExists,
} from "./push-apns.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function makeTempDir(): Promise<string> {
  return await tempDirs.make("openclaw-doctor-push-apns-test-");
}

async function writeLegacyApnsState(baseDir: string, value: unknown): Promise<string> {
  const statePath = path.join(baseDir, "push", "apns-registrations.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return statePath;
}

describe("legacy APNs registration migration", () => {
  it("imports legacy registrations into SQLite and removes the source", async () => {
    const baseDir = await makeTempDir();
    const statePath = await writeLegacyApnsState(baseDir, {
      registrationsByNodeId: {
        " ios-node-legacy ": {
          nodeId: " ios-node-legacy ",
          token: "<ABCD1234ABCD1234ABCD1234ABCD1234>",
          topic: " ai.openclaw.ios ",
          environment: " PRODUCTION ",
          updatedAtMs: 3,
        },
        "   ": {
          nodeId: " ios-node-fallback ",
          token: "<ABCD1234ABCD1234ABCD1234ABCD1234>",
          topic: " ai.openclaw.ios ",
          updatedAtMs: 2,
        },
        "ios-node-bad-relay": {
          transport: "relay",
          nodeId: "ios-node-bad-relay",
          relayHandle: "relay-handle-123",
          sendGrant: "send-grant-123",
          installationId: "install-123",
          topic: "ai.openclaw.ios",
          environment: "production",
          distribution: "beta",
          updatedAtMs: 1,
        },
      },
    });

    await expect(importLegacyApnsRegistrationFileToSqlite(baseDir)).resolves.toEqual({
      imported: true,
      registrations: 2,
    });

    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(loadApnsRegistration("ios-node-legacy", baseDir)).resolves.toMatchObject({
      nodeId: "ios-node-legacy",
      transport: "direct",
      token: "abcd1234abcd1234abcd1234abcd1234",
      topic: "ai.openclaw.ios",
      environment: "production",
      updatedAtMs: 3,
    });
    await expect(loadApnsRegistration("ios-node-fallback", baseDir)).resolves.toMatchObject({
      nodeId: "ios-node-fallback",
      transport: "direct",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      updatedAtMs: 2,
    });
    await expect(loadApnsRegistration("ios-node-bad-relay", baseDir)).resolves.toBeNull();
  });

  it("leaves malformed legacy registration state untouched", async () => {
    const baseDir = await makeTempDir();
    await writeLegacyApnsState(baseDir, []);

    await expect(importLegacyApnsRegistrationFileToSqlite(baseDir)).resolves.toEqual({
      imported: false,
      registrations: 0,
    });
    await expect(legacyApnsRegistrationFileExists(baseDir)).resolves.toBe(true);
  });

  it("skips when the legacy registration file is missing", async () => {
    const baseDir = await makeTempDir();

    await expect(importLegacyApnsRegistrationFileToSqlite(baseDir)).resolves.toEqual({
      imported: false,
      registrations: 0,
    });
    await expect(legacyApnsRegistrationFileExists(baseDir)).resolves.toBe(false);
  });
});
