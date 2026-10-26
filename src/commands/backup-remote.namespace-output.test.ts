import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasTerminalControl } from "../../packages/terminal-core/src/safe-text.js";
import { captureRuntimeConfigAsyncReader } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { initStorageLocation } from "../storage/locations.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { assertBackupNamespaceOwner } from "./backup-namespace.js";
import { backupListCommand } from "./backup-remote.js";

afterEach(() => vi.restoreAllMocks());

// Another installation (or anyone who can write the shared location) controls owner.json.
const HOSTILE_HOSTNAME = "laptop\u001b]0;owned\u0007\u001b[2J\u001b[31mFAKE: backup OK";
const HOSTILE_DEVICE_ID = "\u001b[2Jdevice-0123456789";

async function withForeignNamespace(
  exercise: (location: Awaited<ReturnType<typeof initStorageLocation>>) => Promise<void>,
) {
  await withOpenClawTestState({ layout: "state-only" }, async (state) => {
    const destination = state.path("offsite");
    await fs.mkdir(destination);
    await state.writeConfig({
      storage: {
        locations: {
          archive: { provider: "filesystem", settings: { path: destination }, encryption: "none" },
        },
      },
    });
    const location = await initStorageLocation({
      name: "archive",
      config: await captureRuntimeConfigAsyncReader()(),
    });
    try {
      const namespaceDir = path.join(destination, "backups", "laptop");
      await fs.mkdir(namespaceDir, { recursive: true });
      await fs.writeFile(
        path.join(namespaceDir, "owner.json"),
        JSON.stringify({
          version: 1,
          deviceId: HOSTILE_DEVICE_ID,
          hostname: HOSTILE_HOSTNAME,
          claimedAt: 0,
        }),
      );
      await fs.writeFile(path.join(namespaceDir, "20261026T000000Z-deadbeef.tar.gz"), "x");
      await exercise(location);
    } finally {
      await location.close();
    }
  });
}

describe("backup namespace owner output", () => {
  it("escapes the remote owner hostname in human backup listings", async () => {
    await withForeignNamespace(async () => {
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

      const result = await backupListCommand(defaultRuntime, { from: "archive" });

      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("laptop (laptop");
      expect(output).toContain("FAKE: backup OK)");
      expect(output.split("\n").filter(hasTerminalControl)).toEqual([]);
      expect(result.namespaces).toContainEqual({ namespace: "laptop", hostname: HOSTILE_HOSTNAME });
    });
  });

  it("escapes the remote owner identity in ownership refusals", async () => {
    await withForeignNamespace(async (location) => {
      const refusal = await assertBackupNamespaceOwner(
        location.scope("backups/laptop"),
        "laptop",
        "this-installation",
      ).catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(Error);
      const message = (refusal as Error).message;
      expect(message).toContain("belongs to another OpenClaw installation (laptop");
      expect(hasTerminalControl(message)).toBe(false);
    });
  });
});
