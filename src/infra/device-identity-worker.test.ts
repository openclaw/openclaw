import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { loadOAuthHostPublicKey } from "../plugin-sdk/provider-oauth-runtime.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadDeviceIdentityIfPresentAsync,
  loadOrCreateDeviceIdentityAsync,
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
  const databasePath = state.statePath("state", "openclaw.sqlite");
  try {
    await run({ path: databasePath, env: state.env }, state.stateDir);
  } finally {
    // Keep the fixture intact if native drainage cannot establish cleanup.
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    await state.cleanup();
  }
}

describe("device identity shared worker", () => {
  it("exposes the persisted primary public key to OAuth and isolates separate installations", async () => {
    await withIdentityWorkerState(async (options, stateDir) => {
      const identity = await loadOrCreateDeviceIdentityAsync(options);
      expect(await loadOAuthHostPublicKey(options.env)).toBe(identity.publicKeyPem);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      try {
        expect(await loadOAuthHostPublicKey()).toBe(identity.publicKeyPem);
      } finally {
        vi.unstubAllEnvs();
      }
      await closeOpenClawStateDatabaseByPathAsync(options.path);
      expect((await loadDeviceIdentityIfPresentAsync(options))?.publicKeyPem).toBe(
        identity.publicKeyPem,
      );

      const otherStateDir = path.join(stateDir, "other-installation");
      const otherOptions = {
        path: path.join(otherStateDir, "state", "openclaw.sqlite"),
        env: { ...options.env, OPENCLAW_STATE_DIR: otherStateDir },
      };
      try {
        const publicKey = await loadOAuthHostPublicKey(otherOptions.env);
        expect(publicKey).not.toBe(identity.publicKeyPem);
        await closeOpenClawStateDatabaseByPathAsync(otherOptions.path);
        // Read through the durable owner so a cached facade result cannot hide missing persistence.
        expect((await loadDeviceIdentityIfPresentAsync(otherOptions))?.publicKeyPem).toBe(
          publicKey,
        );
        expect(await loadOAuthHostPublicKey(options.env)).toBe(identity.publicKeyPem);
      } finally {
        await closeOpenClawStateDatabaseByPathAsync(otherOptions.path);
      }
    });
  });

  it("does not initialize an existing empty database during a read", async () => {
    await withIdentityWorkerState(async (options) => {
      const directory = path.dirname(options.path);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(options.path, "", { mode: 0o640 });
      const artifacts = await fs.readdir(directory);
      const fileMode = (await fs.stat(options.path)).mode;

      expect(await loadDeviceIdentityIfPresentAsync(options)).toBeNull();

      expect(await fs.readFile(options.path)).toHaveLength(0);
      expect((await fs.stat(options.path)).mode).toBe(fileMode);
      expect(await fs.readdir(directory)).toEqual(artifacts);
    });
  });

  it("creates one identity off the host and reuses an existing-only actor for another key", async () => {
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
        await closeOpenClawStateDatabaseByPathAsync(options.path);
        const artifacts = await fs.readdir(path.dirname(options.path));
        const fileMode = (await fs.stat(options.path)).mode;
        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        await closeOpenClawStateDatabaseByPathAsync(options.path);
        expect(await fs.readdir(path.dirname(options.path))).toEqual(artifacts);
        expect((await fs.stat(options.path)).mode).toBe(fileMode);

        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        const secondaryOptions = { ...options, identityKey: "secondary" };
        const secondary = await loadOrCreateDeviceIdentityAsync(secondaryOptions);
        expect(secondary.deviceId).not.toBe(first.deviceId);
        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        await closeOpenClawStateDatabaseByPathAsync(options.path);
        expect(await loadDeviceIdentityIfPresentAsync(secondaryOptions)).toEqual(secondary);
        expect(await loadDeviceIdentityIfPresentAsync(options)).toEqual(first);
        await closeOpenClawStateDatabaseByPathAsync(options.path);
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }
    });
  });

  it.each(["device.json", "device.json.doctor-importing", "device.json.native-importing"])(
    "refuses pending legacy %s before creating SQLite",
    async (legacyName) => {
      await withIdentityWorkerState(async (options, stateDir) => {
        const identityDir = path.join(stateDir, "identity");
        await fs.mkdir(identityDir, { recursive: true });
        await fs.writeFile(path.join(identityDir, legacyName), "synthetic retired identity");
        await expect(loadOrCreateDeviceIdentityAsync(options)).rejects.toThrow("doctor --fix");
        await expect(fs.stat(options.path)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(path.join(identityDir, legacyName), "utf8")).toBe(
          "synthetic retired identity",
        );
      });
    },
  );
});
