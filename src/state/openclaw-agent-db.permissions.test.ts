import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  calls: 0,
  failProbe: true,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync: typeof actual.chmodSync = ((target: unknown, mode: unknown) => {
    chmodFailHook.calls += 1;
    const isProbe = String(target).includes(".openclaw-chmod-probe-");
    if (chmodFailHook.error && (chmodFailHook.failProbe || !isProbe)) {
      throw chmodFailHook.error;
    }
    return (actual.chmodSync as (...args: unknown[]) => unknown)(target, mode);
  }) as typeof actual.chmodSync;
  return { ...actual, chmodSync, default: { ...actual, chmodSync } };
});

const fs = await import("node:fs");
const { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } =
  await import("./openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("./openclaw-state-db.js");

function chmodError(code: string): Error {
  const err = new Error(`${code}: chmod failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function enotsupError(): Error {
  return chmodError("ENOTSUP");
}

describe("agent database permission hardening without chmod support", () => {
  let stateDir: string | undefined;

  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.calls = 0;
    chmodFailHook.failProbe = true;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("opens the agent database when chmodSync throws ENOTSUP", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    chmodFailHook.error = enotsupError();

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(database.db.isOpen).toBe(true);
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  it("rethrows unexpected chmod errors at open", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    chmodFailHook.error = chmodError("EACCES");

    expect(() =>
      openOpenClawAgentDatabase({ agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } }),
    ).toThrow(/EACCES/);
  });

  it("opens when the filesystem probe also rejects chmod with EPERM", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    const agentDir = join(stateDir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.chmodSync(agentDir, 0o755);
    chmodFailHook.error = chmodError("EPERM");

    const database = openOpenClawAgentDatabase({
      agentId: "main",
      env: { OPENCLAW_STATE_DIR: stateDir },
    });

    expect(database.db.isOpen).toBe(true);
  });
});
