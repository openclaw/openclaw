import { spawnSync } from "node:child_process";
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

/**
 * Lays out the private stores an fsGroup volume remount broadens.
 *
 * The capture root is a hard sibling of the state directory, so the tracked
 * temporary directory has to be their shared parent; tracking the state
 * directory alone would leak a capture directory per test.
 */
function installation() {
  const root = dirs.make("state-store-modes-");
  const stateDir = path.join(root, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.chmodSync(stateDir, 0o700);
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const credentials = resolveClientCredentialStorePath(env);
  const runtimePins = resolveDaemonRuntimePinStorePath(env);
  const captures = resolveUpdateCaptureRoot(stateDir);
  for (const store of [credentials, runtimePins]) {
    fs.mkdirSync(path.dirname(store), { recursive: true, mode: 0o700 });
    fs.writeFileSync(store, `retained ${path.basename(store)}`, { mode: 0o600 });
  }
  fs.mkdirSync(captures, { recursive: true, mode: 0o700 });
  return { env, root, stateDir, credentials, runtimePins, captures };
}

describe.runIf(process.platform !== "win32")("restorePrivateStateStoreModes", () => {
  it("skips a writerless FIFO sidecar without blocking startup", () => {
    const { env, credentials } = installation();
    const sidecar = credentials + "-wal";
    expect(spawnSync("mkfifo", [sidecar], { timeout: 5_000 }).status).toBe(0);
    const before = fs.lstatSync(sidecar, { bigint: true });
    // Bound the synchronous open in a child: a regression must not strand the worker.
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "--input-type=module",
        "-e",
        'import { restorePrivateStateStoreModes } from "./src/state/openclaw-state-db-permissions.ts"; restorePrivateStateStoreModes({ OPENCLAW_STATE_DIR: process.argv[1] });',
        env.OPENCLAW_STATE_DIR,
      ],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const after = fs.lstatSync(sidecar, { bigint: true });
    expect(after.isFIFO()).toBe(true);
    expect(after.mode).toBe(before.mode);
    expect(after.ctimeNs).toBe(before.ctimeNs);
  }, 15_000);

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

  it("refuses a store file reached through a symlinked store directory", () => {
    const { env, stateDir, credentials } = installation();
    const outside = path.join(dirs.make("state-store-outside-"), "target");
    fs.mkdirSync(outside);
    // mkdir masks its mode by umask, so set the remount-style mode explicitly.
    fs.chmodSync(outside, 0o2770);
    // A database file this process owns, at a broadened mode, outside the installation.
    const smuggled = path.join(outside, path.basename(credentials));
    fs.writeFileSync(smuggled, "outside this installation");
    fs.chmodSync(smuggled, 0o660);
    fs.rmSync(path.dirname(credentials), { recursive: true });
    fs.symlinkSync(outside, path.dirname(credentials));
    fs.chmodSync(stateDir, 0o2770);

    restorePrivateStateStoreModes(env);

    // Refusing the directory has to stop the walk: a pathname below it would
    // resolve through the alias, and chmod would land outside the installation.
    expect(mode(outside)).toBe(0o2770);
    expect(mode(smuggled)).toBe(0o660);
    expect(fs.readFileSync(smuggled, "utf8")).toBe("outside this installation");
  });

  it("refuses a store file that has another name outside the installation", () => {
    const { env, credentials } = installation();
    const alias = path.join(dirs.make("state-store-linked-"), "alias.sqlite");
    fs.chmodSync(credentials, 0o660);
    fs.linkSync(credentials, alias);

    restorePrivateStateStoreModes(env);

    // A mode change travels through every name a file has, including one this
    // repair has no authority over, so a multiply linked store stays refused.
    expect(mode(credentials)).toBe(0o660);
    expect(mode(alias)).toBe(0o660);
  });

  it("skips a store directory it cannot open instead of failing the start", () => {
    const { env, credentials } = installation();
    const directory = path.dirname(credentials);
    try {
      // Owner-class permissions are checked first, so this denies read to the
      // owner too. Admission has to open the object to verify its identity, so
      // an unopenable store is left alone rather than mutated unverified -- and
      // permission hardening stays best-effort, never fatal to a start (#91919).
      fs.chmodSync(directory, 0o2070);

      expect(() => restorePrivateStateStoreModes(env)).not.toThrow();

      expect(mode(directory)).toBe(0o2070);
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  });

  it("refuses a store path that is not a regular file", () => {
    const { env, credentials } = installation();
    fs.rmSync(credentials);
    fs.mkdirSync(credentials);
    fs.chmodSync(credentials, 0o2770);

    restorePrivateStateStoreModes(env);

    expect(mode(credentials)).toBe(0o2770);
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
    const stateDir = path.join(dirs.make("state-store-admission-"), ".openclaw");
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

  // Kept deliberately. PRIVATE_STATE_STORES repeats these path literals, and
  // nothing else fails if a resolver moves a store while that constant stays
  // put: the restore would quietly stop covering it and #192959 would come back.
  // Every repair test above reaches its paths through the resolvers, so none of
  // them can see that drift. Review flagged this as low value; this records why
  // it is here, so the next reader removes it on purpose rather than by default.
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
