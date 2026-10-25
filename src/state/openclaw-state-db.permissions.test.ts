import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

// Reset preloaded helpers and mock both import forms; a namespace spy cannot rebind them.
const fault = vi.hoisted(() => {
  vi.resetModules();
  return {
    error: undefined as Error | undefined,
    failProbe: true,
    removeSuffix: undefined as string | undefined,
    targets: [] as string[],
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = (target, mode) => {
    fault.targets.push(String(target));
    if (fault.removeSuffix && String(target).endsWith(fault.removeSuffix)) {
      // Remove the file after existsSync reaches chmod to reproduce the exact race.
      actual.unlinkSync(String(target));
    }
    const isProbe = String(target).includes(".openclaw-chmod-probe-");
    if (fault.error && (fault.failProbe || !isProbe)) {
      throw fault.error;
    }
    return actual.chmodSync(target, mode);
  };
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const fs = await import("node:fs");
const { closeOpenClawStateDatabaseForTest, openOpenClawStateDatabase } =
  await import("./openclaw-state-db.js");
const { ensureOpenClawStatePermissions } = await import("./openclaw-state-db-permissions.js");

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    fault.error = undefined;
    fault.failProbe = true;
    fault.removeSuffix = undefined;
    fault.targets = [];
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

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
  fault.targets = [];

  ensureOpenClawStatePermissions(pathname, env);

  expect(fault.targets).toEqual([]);
  expect(fs.statSync(pathname, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
});

it.each([true, false])("handles EPERM with restrictive existing permissions=%s", (restrictive) => {
  const { options, env } = fixture(restrictive);
  if (!restrictive) {
    const directory = join(env.OPENCLAW_STATE_DIR, "state");
    fs.mkdirSync(directory);
    fs.chmodSync(directory, 0o755);
  }
  fault.error = Object.assign(new Error("EPERM: chmod failed"), { code: "EPERM" });
  fault.failProbe = restrictive;
  if (restrictive) {
    expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
  } else {
    expect(() => openOpenClawStateDatabase(options)).toThrow(/EPERM/);
  }
});

it.each(["-wal", ""])("handles a database file vanishing before chmod (suffix=%s)", (suffix) => {
  const { options, pathname } = fixture();
  const target = `${pathname}${suffix}`;
  if (suffix) {
    fs.writeFileSync(target, "");
  }
  fs.chmodSync(target, 0o644);
  fault.removeSuffix = suffix || "openclaw.sqlite";
  if (suffix) {
    ensureOpenClawStatePermissions(pathname, options.env);
    expect(fs.existsSync(target)).toBe(false);
    expect(openOpenClawStateDatabase(options).db.isOpen).toBe(true);
  } else {
    // Losing the main file must not silently create an empty replacement.
    expect(() => openOpenClawStateDatabase(options)).toThrow(/ENOENT/);
  }
  expect(fault.targets).toContain(target);
});
