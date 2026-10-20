import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadChatRequestIdentityKeyAsync,
  loadDeviceIdentityIfPresentAsync,
  loadOrCreateDeviceIdentityAsync,
  loadOrCreateProcessDeviceIdentityAsync,
} from "./device-identity-async.js";
import type { DeviceIdentityStoreOptions } from "./device-identity-store.js";
import { signDevicePayload, verifyDeviceSignature } from "./device-identity.js";

async function withIdentityWorkerState(
  run: (options: DeviceIdentityStoreOptions & { path: string }, stateDir: string) => Promise<void>,
): Promise<void> {
  const state = await createOpenClawTestState({
    label: "device-identity-worker",
    layout: "state-only",
    applyEnv: false,
  });
  const databasePath = state.statePath("client", "credentials.sqlite");
  try {
    await run({ path: databasePath, env: state.env }, state.stateDir);
  } finally {
    await state.cleanup();
  }
}

describe("device identity local worker", () => {
  it("keeps process identities cached by database path and identity key", async () => {
    await withIdentityWorkerState(async (options, stateDir) => {
      const secondaryOptions = { ...options, identityKey: "secondary" };
      const primary = await loadOrCreateProcessDeviceIdentityAsync(options);
      const secondary = await loadOrCreateProcessDeviceIdentityAsync(secondaryOptions);
      expect(await loadOrCreateProcessDeviceIdentityAsync(options)).toBe(primary);
      expect(await loadOrCreateProcessDeviceIdentityAsync(secondaryOptions)).toBe(secondary);
      expect(secondary.deviceId).not.toBe(primary.deviceId);
      const claimPath = path.join(stateDir, "identity", "device.json.doctor-importing");
      await fs.mkdir(path.dirname(claimPath), { recursive: true });
      await fs.writeFile(claimPath, "synthetic retired identity");
      expect(await loadOrCreateProcessDeviceIdentityAsync(options)).toBe(primary);
      expect(await fs.readFile(claimPath, "utf8")).toBe("synthetic retired identity");
    });
  });

  it("refuses an existing empty credential store without initializing it", async () => {
    await withIdentityWorkerState(async (options) => {
      const directory = path.dirname(options.path);
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.writeFile(options.path, "", { mode: 0o600 });
      const artifacts = await fs.readdir(directory);
      const fileMode = (await fs.stat(options.path)).mode;

      await expect(loadDeviceIdentityIfPresentAsync(options)).rejects.toThrow(
        "Client credential store is empty; run openclaw doctor --fix.",
      );
      expect(await loadChatRequestIdentityKeyAsync(options)).toBeNull();

      expect(await fs.readFile(options.path)).toHaveLength(0);
      expect((await fs.stat(options.path)).mode).toBe(fileMode);
      expect(await fs.readdir(directory)).toEqual(artifacts);
    });
  });

  it("creates one identity off the host and preserves independent identity keys", async () => {
    await withIdentityWorkerState(async (options, stateDir) => {
      const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      try {
        const emptyArtifacts = await fs.readdir(stateDir);
        expect(await loadDeviceIdentityIfPresentAsync(options)).toBeNull();
        expect(await fs.readdir(stateDir)).toEqual(emptyArtifacts);
        const [first, second] = await Promise.all([
          loadOrCreateDeviceIdentityAsync(options),
          loadOrCreateDeviceIdentityAsync(options),
        ]);
        expect(second).toEqual(first);
        const signature = signDevicePayload(first.privateKeyPem, "synthetic-identity-proof");
        expect(
          verifyDeviceSignature(first.publicKeyPem, "synthetic-identity-proof", signature),
        ).toBe(true);
        const bytes = await fs.readFile(options.path);
        const fileMode = (await fs.stat(options.path)).mode;
        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        expect(await fs.readFile(options.path)).toEqual(bytes);
        expect(statSync(`${options.path}-wal`, { throwIfNoEntry: false })?.size ?? 0).toBe(0);
        expect((await fs.stat(options.path)).mode).toBe(fileMode);

        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        const secondaryOptions = { ...options, identityKey: "secondary" };
        const secondary = await loadOrCreateDeviceIdentityAsync(secondaryOptions);
        expect(secondary.deviceId).not.toBe(first.deviceId);
        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        expect(await loadDeviceIdentityIfPresentAsync(secondaryOptions)).toEqual(secondary);
        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
    });
  });

  it("refuses a pending native identity import before creating SQLite", async () => {
    await withIdentityWorkerState(async (options, stateDir) => {
      const identityDir = path.join(stateDir, "identity");
      const legacyPath = path.join(identityDir, "device.json.native-importing");
      await fs.mkdir(identityDir, { recursive: true });
      await fs.writeFile(legacyPath, "synthetic retired identity");
      await expect(loadOrCreateDeviceIdentityAsync(options)).rejects.toThrow("doctor --fix");
      await expect(fs.stat(options.path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(legacyPath, "utf8")).toBe("synthetic retired identity");
    });
  });
});
