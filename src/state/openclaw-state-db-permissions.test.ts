import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveManagedGitHubProfileDir } from "../agents/github-tool-profile-path.js";
import { resolveDaemonRuntimePinStorePath } from "../daemon/runtime-pin-store.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { restorePrivateStateStoreModes } from "./openclaw-state-db-permissions.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const mode = (target: string) => fs.lstatSync(target).mode & 0o7777;

/** Applies what an fsGroup remount re-applies: setgid, and the owner bits in the group class. */
function remountBroaden(directory: string): void {
  fs.chmodSync(directory, 0o2770);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      remountBroaden(target);
    } else {
      fs.chmodSync(target, 0o660);
    }
  }
}

/** Asserts the restore narrowed a whole private store back to its owner alone. */
function expectPrivateStore(directory: string): void {
  expect(mode(directory)).toBe(0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      expectPrivateStore(target);
    } else {
      expect(mode(target)).toBe(0o600);
    }
  }
}

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
  // Stores whose names are minted at runtime: one managed GitHub identity
  // generation per scope, and the runtime bundle an enrolled Codex worker reads back.
  const profileId = `ghp_${"0123456789abcdef".repeat(2)}`;
  const profile = resolveManagedGitHubProfileDir({
    agentId: "main",
    env,
    scope: "system",
    profileId,
  });
  const agentProfile = resolveManagedGitHubProfileDir({
    agentId: "main",
    env,
    scope: "agent",
    profileId,
  });
  for (const generation of [profile, agentProfile]) {
    fs.mkdirSync(generation, { recursive: true, mode: 0o700 });
    for (const name of ["config.yml", "hosts.yml"]) {
      fs.writeFileSync(path.join(generation, name), `retained ${name}`, { mode: 0o600 });
    }
  }
  const codexRuntime = path.join(stateDir, "codex-runtime");
  fs.mkdirSync(codexRuntime, { recursive: true, mode: 0o700 });
  for (const name of ["config.toml", "openclaw-auth.mjs", "version"]) {
    fs.writeFileSync(path.join(codexRuntime, name), `retained ${name}`, { mode: 0o600 });
  }
  return {
    env,
    root,
    stateDir,
    credentials,
    runtimePins,
    captures,
    profile,
    agentProfile,
    codexRuntime,
  };
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
    const {
      env,
      stateDir,
      credentials,
      runtimePins,
      captures,
      profile,
      agentProfile,
      codexRuntime,
    } = installation();
    // A remount re-applies group permissions to every directory and file, and
    // Linux propagates the volume's setgid bit into directories created under it.
    remountBroaden(stateDir);
    remountBroaden(captures);
    const stateDirMode = mode(stateDir);

    restorePrivateStateStoreModes(env);

    for (const store of [
      path.dirname(credentials),
      path.dirname(runtimePins),
      captures,
      profile,
      agentProfile,
      codexRuntime,
    ]) {
      expectPrivateStore(store);
    }
    // A shared, group-accessible state root is a supported layout, and config
    // publication preserves its mode, so the restore must leave it untouched.
    expect(mode(stateDir)).toBe(stateDirMode);
    for (const store of [credentials, runtimePins]) {
      expect(fs.readFileSync(store, "utf8")).toBe(`retained ${path.basename(store)}`);
    }
  });

  // A state directory need not hold every store: each admits itself.
  it.each(["capture root", "minted stores"] as const)(
    "restores a state directory that holds only a %s",
    (layout) => {
      const root = dirs.make("state-store-modes-only-");
      const stateDir = path.join(root, ".openclaw");
      fs.mkdirSync(stateDir, { mode: 0o700 });
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const captures = resolveUpdateCaptureRoot(stateDir);
      const minted =
        layout === "capture root"
          ? []
          : [
              resolveManagedGitHubProfileDir({
                agentId: "main",
                env,
                scope: "system",
                profileId: `ghp_${"0123456789abcdef".repeat(2)}`,
              }),
              path.join(stateDir, "codex-runtime"),
            ];
      if (layout === "capture root") {
        fs.mkdirSync(captures, { mode: 0o700 });
        fs.writeFileSync(path.join(captures, "retained"), "retained", { mode: 0o600 });
      }
      for (const store of minted) {
        fs.mkdirSync(store, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(store, "retained"), "retained", { mode: 0o600 });
      }
      // No SQLite store exists here: the repair must not wait for one.
      expect(fs.existsSync(path.join(stateDir, "client"))).toBe(false);

      remountBroaden(stateDir);
      // The capture root is a sibling of the state directory, outside that walk.
      if (layout === "capture root") {
        remountBroaden(captures);
      }

      restorePrivateStateStoreModes(env);

      if (layout === "capture root") {
        // Only the root directory is repaired; its writer admits the files.
        expect(mode(captures)).toBe(0o700);
        expect(fs.readFileSync(path.join(captures, "retained"), "utf8")).toBe("retained");
      }
      for (const store of minted) {
        expectPrivateStore(store);
      }
    },
  );

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
    const { env, stateDir, credentials, profile } = installation();
    const foreign = path.join(dirs.make("state-store-foreign-"), "target");
    fs.mkdirSync(foreign);
    // mkdir masks its mode by umask, so set the remount-style mode explicitly.
    fs.chmodSync(foreign, 0o2770);
    fs.rmSync(path.dirname(credentials), { recursive: true });
    fs.symlinkSync(foreign, path.dirname(credentials));
    // The scope root above a minted store is not private itself, but entering it
    // through an alias would lend the repair to a tree outside the installation.
    const scope = path.join(dirs.make("state-store-scope-"), "target");
    fs.mkdirSync(scope);
    fs.renameSync(profile, path.join(scope, path.basename(profile)));
    fs.rmdirSync(path.dirname(profile));
    fs.symlinkSync(scope, path.dirname(profile));
    remountBroaden(scope);
    fs.chmodSync(stateDir, 0o2770);

    restorePrivateStateStoreModes(env);

    expect(fs.lstatSync(path.dirname(credentials)).isSymbolicLink()).toBe(true);
    expect(mode(foreign)).toBe(0o2770);
    const grafted = path.join(scope, path.basename(profile));
    expect(mode(grafted)).toBe(0o2770);
    expect(mode(path.join(grafted, "hosts.yml"))).toBe(0o660);
    expect(mode(stateDir)).toBe(0o2770);
  });

  it("refuses a store chain reached through a symlinked credentials directory", () => {
    const { env, stateDir, credentials, profile, codexRuntime } = installation();
    const external = path.join(dirs.make("state-store-credential-chain-"), "target");
    fs.mkdirSync(path.join(external, "github", "system"), { recursive: true });
    const generation = path.join(external, "github", "system", path.basename(profile));
    fs.mkdirSync(generation);
    for (const name of ["config.yml", "hosts.yml"]) {
      fs.writeFileSync(path.join(generation, name), `outside ${name}`, { mode: 0o600 });
    }
    fs.rmSync(path.join(stateDir, "credentials"), { recursive: true });
    fs.symlinkSync(external, path.join(stateDir, "credentials"));
    remountBroaden(external);
    remountBroaden(path.dirname(credentials));
    remountBroaden(codexRuntime);
    fs.chmodSync(stateDir, 0o2770);

    restorePrivateStateStoreModes(env);

    // Entering credentials/ through an alias would lend the repair to another tree.
    expect(mode(external)).toBe(0o2770);
    expect(mode(generation)).toBe(0o2770);
    expect(mode(path.join(generation, "hosts.yml"))).toBe(0o660);
    // The stores this installation still names are repaired as before.
    expect(mode(path.dirname(credentials))).toBe(0o700);
    expect(mode(credentials)).toBe(0o600);
    expectPrivateStore(codexRuntime);
    expect(mode(stateDir)).toBe(0o2770);
  });

  it("refuses a store chain reached through a symlinked managed-github directory", () => {
    const { env, stateDir, credentials, profile, codexRuntime } = installation();
    const external = path.join(dirs.make("state-store-github-chain-"), "target");
    fs.mkdirSync(path.join(external, "system"), { recursive: true });
    const generation = path.join(external, "system", path.basename(profile));
    fs.mkdirSync(generation);
    for (const name of ["config.yml", "hosts.yml"]) {
      fs.writeFileSync(path.join(generation, name), `outside ${name}`, { mode: 0o600 });
    }
    const managedGitHub = path.join(stateDir, "credentials", "github");
    fs.rmSync(managedGitHub, { recursive: true });
    fs.symlinkSync(external, managedGitHub);
    remountBroaden(external);
    remountBroaden(path.dirname(credentials));
    remountBroaden(codexRuntime);
    fs.chmodSync(stateDir, 0o2770);

    restorePrivateStateStoreModes(env);

    expect(mode(generation)).toBe(0o2770);
    expect(mode(path.join(generation, "hosts.yml"))).toBe(0o660);
    expect(mode(path.dirname(credentials))).toBe(0o700);
    expect(mode(credentials)).toBe(0o600);
    expectPrivateStore(codexRuntime);
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
    const outsideMode = mode(outside);
    fs.chmodSync(stateDir, 0o2770);

    restorePrivateStateStoreModes(env);

    // Refusing the directory has to stop the walk: a pathname below it would
    // resolve through the alias, and chmod would land outside the installation.
    expect(mode(outside)).toBe(outsideMode);
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
      const before = mode(directory);

      expect(() => restorePrivateStateStoreModes(env)).not.toThrow();

      expect(mode(directory)).toBe(before);
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  });

  it("refuses a store path that is not a regular file", () => {
    const { env, credentials } = installation();
    fs.rmSync(credentials);
    fs.mkdirSync(credentials);
    fs.chmodSync(credentials, 0o2770);
    const before = mode(credentials);

    restorePrivateStateStoreModes(env);

    expect(mode(credentials)).toBe(before);
  });

  it("leaves an already-private installation untouched", () => {
    const { env, credentials } = installation();
    const before = fs.lstatSync(credentials).ctimeMs;

    restorePrivateStateStoreModes(env);

    expect(mode(credentials)).toBe(0o600);
    expect(fs.lstatSync(credentials).ctimeMs).toBe(before);
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
