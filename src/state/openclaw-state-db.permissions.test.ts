import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

// Mock both import forms: spying on the namespace cannot rebind captured named imports.
const chmodFailHook = vi.hoisted(() => {
  // Runtime setup can preload permission helpers before this file's filesystem mock.
  vi.resetModules();
  return {
    error: undefined as Error | undefined,
    failProbe: true,
    removeTargetSuffix: undefined as string | undefined,
    targets: [] as string[],
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.targets.push(String(target));
    if (
      chmodFailHook.removeTargetSuffix &&
      String(target).endsWith(chmodFailHook.removeTargetSuffix)
    ) {
      // Remove the file after existsSync reaches chmod to reproduce the exact race.
      actual.unlinkSync(String(target));
    }
    const isProbe = String(target).includes(".openclaw-chmod-probe-");
    if (chmodFailHook.error && (chmodFailHook.failProbe || !isProbe)) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const fs = await import("node:fs");
const { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } =
  await import("./openclaw-state-db.js");
const { ensureOpenClawStatePermissions } = await import("./openclaw-state-db-permissions.js");

function chmodError(code: string): Error {
  return Object.assign(new Error(`${code}: chmod failed`), { code });
}

describe("state database permission hardening without chmod support", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(() => {
      chmodFailHook.error = undefined;
      chmodFailHook.failProbe = true;
      chmodFailHook.removeTargetSuffix = undefined;
      chmodFailHook.targets = [];
      closeOpenClawStateDatabaseForTest();
      cleanup();
    });
  });

  function fixture(initialize = true) {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-state-chmod-") };
    const options = { env };
    if (initialize) {
      openOpenClawStateDatabase(options);
      closeOpenClawStateDatabaseForTest();
    }
    return { options, env, pathname: join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite") };
  }

  it.skipIf(process.platform === "win32")("leaves already-private metadata unchanged", () => {
    const { pathname, env } = fixture();
    const before = fs.statSync(pathname, { bigint: true });
    chmodFailHook.targets = [];

    ensureOpenClawStatePermissions(pathname, env);

    expect(chmodFailHook.targets).toEqual([]);
    expect(fs.statSync(pathname, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
  });

  it("rethrows EPERM when existing permissions are too broad", () => {
    const { options, env } = fixture(false);
    // The shared database owner hardens state/, not the outer profile directory.
    const databaseDir = join(env.OPENCLAW_STATE_DIR, "state");
    fs.mkdirSync(databaseDir);
    fs.chmodSync(databaseDir, 0o755);
    chmodFailHook.error = chmodError("EPERM");
    chmodFailHook.failProbe = false;

    expect(() => openOpenClawStateDatabase(options)).toThrow(/EPERM/);
  });

  it("opens when EPERM leaves existing permissions restrictive", () => {
    const { options } = fixture();
    chmodFailHook.error = chmodError("EPERM");

    expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
  });

  it("opens when the -wal sidecar disappears before chmod", () => {
    const { options, pathname } = fixture();
    const sidecarPath = `${pathname}-wal`;
    fs.writeFileSync(sidecarPath, "");
    fs.chmodSync(sidecarPath, 0o644);
    chmodFailHook.removeTargetSuffix = "-wal";

    ensureOpenClawStatePermissions(pathname, options.env);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(chmodFailHook.targets).toContain(sidecarPath);
    expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
  });

  it("rethrows when the main database vanishes between the existence check and the chmod", () => {
    // Swallowing ENOENT here would silently recreate the lost main database.
    const { options, pathname } = fixture();
    fs.chmodSync(pathname, 0o644);
    chmodFailHook.removeTargetSuffix = "openclaw.sqlite";

    expect(() => openOpenClawStateDatabase(options)).toThrow(/ENOENT/);
    // Guards against a vacuous pass if the main file were skipped before chmod.
    expect(chmodFailHook.targets.some((target) => target.endsWith("openclaw.sqlite"))).toBe(true);
  });
});
