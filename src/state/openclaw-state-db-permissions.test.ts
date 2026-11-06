import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDaemonRuntimePinStorePath } from "../daemon/runtime-pin-store.js";
import type { ClientIdentityRecord } from "../infra/client-credential-operations.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { runClientCredentialOperation } from "../infra/client-credential-store.js";
import {
  generateStoredDeviceIdentity,
  storedDeviceIdentityToRow,
} from "../infra/device-identity-material.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import {
  ensureOpenClawStatePermissions,
  restorePrivateStateStoreModes,
} from "./openclaw-state-db-permissions.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const mode = (target: string) => fs.lstatSync(target).mode & 0o7777;

/** Lays out the private stores an fsGroup volume remount broadens. */
function installation() {
  const stateDir = dirs.make("state-store-modes-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const credentials = resolveClientCredentialStorePath(env);
  const runtimePins = resolveDaemonRuntimePinStorePath(env);
  const captures = resolveUpdateCaptureRoot(stateDir);
  for (const store of [credentials, runtimePins]) {
    fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store, `retained ${path.basename(store)}`, { mode: 0o600 });
  }
  fs.mkdirSync(captures, { recursive: true, mode: 0o700 });
  return { env, stateDir, credentials, runtimePins, captures };
}

describe.runIf(process.platform !== "win32")("restorePrivateStateStoreModes", () => {
  it("restores private modes an fsGroup remount broadened and preserves contents", () => {
    const { env, stateDir, credentials, runtimePins, captures } = installation();
    // A remount re-applies group permissions to every directory and file, and
    // Linux propagates the volume's setgid bit into directories created under it.
    for (const directory of [
      stateDir,
      path.dirname(credentials),
      path.dirname(runtimePins),
      captures,
    ]) {
      fs.chmodSync(directory, 0o2770);
    }
    for (const store of [credentials, runtimePins]) {
      fs.chmodSync(store, 0o660);
    }

    restorePrivateStateStoreModes(env);

    for (const directory of [path.dirname(credentials), path.dirname(runtimePins), captures]) {
      expect(mode(directory)).toBe(0o700);
    }
    // A shared, group-accessible state root is a supported layout, and config
    // publication preserves its mode, so the restore must leave it untouched.
    expect(mode(stateDir)).toBe(0o2770);
    for (const store of [credentials, runtimePins]) {
      expect(mode(store)).toBe(0o600);
      expect(fs.readFileSync(store, "utf8")).toBe(`retained ${path.basename(store)}`);
    }
  });

  it("restores the sqlite sidecars a remount broadened alongside their database", () => {
    const { env, credentials } = installation();
    const sidecars = [`${credentials}-wal`, `${credentials}-shm`, `${credentials}-journal`];
    for (const sidecar of sidecars) {
      fs.writeFileSync(sidecar, "sidecar", { mode: 0o660 });
    }

    restorePrivateStateStoreModes(env);

    for (const sidecar of sidecars) {
      expect(mode(sidecar)).toBe(0o600);
    }
  });

  it("leaves world-accessible paths for their owner to refuse", () => {
    const { env, credentials } = installation();
    // fsGroup never sets world bits, so this is not a remount artifact and must
    // keep failing admission instead of being quietly repaired.
    fs.chmodSync(path.dirname(credentials), 0o777);
    fs.chmodSync(credentials, 0o666);

    restorePrivateStateStoreModes(env);

    expect(mode(path.dirname(credentials))).toBe(0o777);
    expect(mode(credentials)).toBe(0o666);
  });

  it("does not follow a symbolic link standing in for a private store", () => {
    const { env, stateDir, credentials } = installation();
    const foreign = path.join(dirs.make("state-store-foreign-"), "target");
    fs.mkdirSync(foreign);
    // mkdir masks its mode by umask, so set the remount-style mode explicitly.
    fs.chmodSync(foreign, 0o2770);
    fs.rmSync(path.dirname(credentials), { recursive: true });
    fs.symlinkSync(foreign, path.dirname(credentials));
    fs.chmodSync(stateDir, 0o2770);

    restorePrivateStateStoreModes(env);

    expect(fs.lstatSync(path.dirname(credentials)).isSymbolicLink()).toBe(true);
    expect(mode(foreign)).toBe(0o2770);
    expect(mode(stateDir)).toBe(0o2770);
  });

  it("leaves an already-private installation untouched", () => {
    const { env, credentials } = installation();
    const before = fs.lstatSync(credentials).ctimeMs;

    restorePrivateStateStoreModes(env);

    expect(mode(credentials)).toBe(0o600);
    expect(fs.lstatSync(credentials).ctimeMs).toBe(before);
  });

  // Red on the base: ensureOpenClawStatePermissions already runs on every Gateway
  // start (gateway-lock) and before Doctor's state-schema step, but hardened only
  // the shared state database, so the credential owner still refused after a remount.
  it("lets the credential owner admit a remounted installation", () => {
    const stateDir = dirs.make("state-store-admission-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const identity: ClientIdentityRecord = storedDeviceIdentityToRow(
      "node",
      generateStoredDeviceIdentity(123),
      456,
    );
    const read = () =>
      runClientCredentialOperation(env, {
        kind: "identity.read",
        identity_key: identity.identity_key,
      });
    runClientCredentialOperation(env, { kind: "identity.create", identity });
    const credentials = resolveClientCredentialStorePath(env);

    for (const [target, broadened] of [
      [stateDir, 0o2770],
      [path.dirname(credentials), 0o2770],
      [credentials, 0o660],
    ] as const) {
      fs.chmodSync(target, broadened);
    }
    expect(() => read()).toThrow("directory is unsafe");

    // Same call the Gateway makes on every start (infra/gateway-lock.ts).
    ensureOpenClawStatePermissions(resolveOpenClawStateSqlitePath(env), env, {
      createDirectory: true,
    });

    expect(read()).toEqual({ kind: "identity", identity });
    expect(mode(path.dirname(credentials))).toBe(0o700);
    expect(mode(credentials)).toBe(0o600);
  });

  it("covers the paths the canonical resolvers own", () => {
    const stateDir = dirs.make("state-store-paths-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    expect(resolveClientCredentialStorePath(env)).toBe(
      path.join(stateDir, "client", "credentials.sqlite"),
    );
    expect(resolveDaemonRuntimePinStorePath(env)).toBe(
      path.join(stateDir, "control", "services.sqlite"),
    );
    expect(resolveUpdateCaptureRoot(stateDir)).toBe(`${path.resolve(stateDir)}.update-captures`);
  });
});
