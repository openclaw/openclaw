import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { closeOpenClawAgentDatabasesForTest, openOpenClawAgentDatabase } =
  await import("./openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("./openclaw-state-db.js");

function chmodError(code: string): Error {
  const err = new Error(`${code}: chmod failed`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function openAgentDb(stateDir: string) {
  return openOpenClawAgentDatabase({ agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } });
}

describe("agent database permission hardening on chmod-less volumes", () => {
  let stateDir: string | undefined;
  const originalPlatform = process.platform;

  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.calls = 0;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    if (stateDir) {
      fs.rmSync(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("hardens the agent database to private modes when chmod succeeds", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));

    const database = openAgentDb(stateDir);

    expect(database.db.isOpen).toBe(true);
    expect(fs.statSync(dirname(database.path)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(database.path).mode & 0o777).toBe(0o600);
  });

  it("opens when chmod fails but the credential store is already private", () => {
    stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
    openAgentDb(stateDir);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    chmodFailHook.error = chmodError("ENOTSUP");

    const database = openAgentDb(stateDir);

    expect(database.db.isOpen).toBe(true);
    expect(chmodFailHook.calls).toBeGreaterThan(0);
  });

  const refusalCases = [
    {
      name: "refuses when chmod fails and the agent directory is not private",
      code: "EPERM",
      win32: false,
      makeNonPrivate: true,
      expected: /cannot be made private/,
    },
    {
      name: "refuses with EACCES on a non-private agent directory",
      code: "EACCES",
      win32: false,
      makeNonPrivate: true,
      expected: /cannot be made private/,
    },
    {
      name: "refuses on Windows when chmod fails because mode bits cannot prove ACL privacy",
      code: "ENOTSUP",
      win32: true,
      makeNonPrivate: false,
      expected: /Windows/,
    },
  ];

  for (const testCase of refusalCases) {
    it(testCase.name, () => {
      stateDir = fs.mkdtempSync(join(tmpdir(), "openclaw-agent-chmod-"));
      const seed = openAgentDb(stateDir);
      const agentDir = dirname(seed.path);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      if (testCase.makeNonPrivate) {
        fs.chmodSync(agentDir, 0o755);
      }
      if (testCase.win32) {
        Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      }
      chmodFailHook.error = chmodError(testCase.code);

      expect(() => openAgentDb(stateDir as string)).toThrow(testCase.expected);
    });
  }
});
