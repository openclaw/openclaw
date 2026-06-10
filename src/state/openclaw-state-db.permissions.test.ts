// State database permission hardening tests cover best-effort chmod on
// filesystems without POSIX permission support (Azure Files, NFS, certain
// Docker volume drivers).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// openclaw-state-db.ts hardens permissions via the named import `chmodSync`
// from node:fs. A namespace `vi.spyOn(fs, ...)` cannot rebind an
// already-captured named import, so we mock node:fs and route chmodSync
// (named + default) through a single controllable failure hook.
const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls += 1;
    if (chmodFailHook.error) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const fs = await import("node:fs");
const {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} = await import("./openclaw-state-db.js");

function enotsupError(): Error {
  const err = new Error("ENOTSUP: operation not supported, chmod") as NodeJS.ErrnoException;
  err.code = "ENOTSUP";
  return err;
}

describe("state database permission hardening without chmod support", () => {
  let stateDir: string | undefined;

  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.calls = 0;
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("opens the state database when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    chmodFailHook.error = enotsupError();

    const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });

    expect(database.db.isOpen).toBe(true);
    // Hardening ran and failed; the failure must stay non-fatal.
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("repairs the schema when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    closeOpenClawStateDatabaseForTest();

    chmodFailHook.error = enotsupError();

    expect(() =>
      repairOpenClawStateDatabaseSchema({ env: { OPENCLAW_STATE_DIR: stateDir } }),
    ).not.toThrow();
  });

  it("commits write transactions when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-state-chmod-"));
    chmodFailHook.error = enotsupError();
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };

    const result = runOpenClawStateWriteTransaction((database) => {
      expect(database.db.isOpen).toBe(true);
      return "committed";
    }, options);

    expect(result).toBe("committed");
  });
});
