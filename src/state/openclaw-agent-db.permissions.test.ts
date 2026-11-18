import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
const chmodFailHook = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  removeTarget: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const chmodSync = new Proxy(actual.chmodSync, {
    apply(target, receiver, args) {
      if (chmodFailHook.error) {
        throw chmodFailHook.error;
      }
      if (chmodFailHook.removeTarget && args[0] === chmodFailHook.removeTarget) {
        actual.unlinkSync(chmodFailHook.removeTarget);
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  const mocked = { ...actual, chmodSync };
  return { ...mocked, default: mocked };
});

const {
  closeOpenClawAgentDatabasesForTest: closeAgents,
  openOpenClawAgentDatabase: openAgent,
  runOpenClawAgentWriteTransaction: writeAgent,
} = await import("./openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest: closeState } = await import("./openclaw-state-db.js");
const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const makeOptions = () => ({
  agentId: "worker-1",
  env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-agent-permissions-") },
});
const permissionFailure = (message: string) =>
  Object.assign(new Error(message), { code: "EACCES" });

describe("agent database permission repair", () => {
  afterEach(() => {
    chmodFailHook.error = undefined;
    chmodFailHook.removeTarget = undefined;
    closeAgents();
    closeState();
  });

  it("refuses to open a database when permission repair fails", () => {
    const options = makeOptions();
    const database = openAgent(options);
    closeAgents();
    const permissionError = permissionFailure("EACCES: chmod failed");
    if (process.platform !== "win32") {
      fs.chmodSync(database.path, 0o644);
    }
    chmodFailHook.error = permissionError;

    expect(() => openAgent(options)).toThrow(permissionError);
    chmodFailHook.error = undefined;
    expect(openAgent(options).db.isOpen).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "leaves warm permissions untouched and repairs permission drift on reopen",
    () => {
      const options = makeOptions();
      const database = openAgent(options);
      const directory = path.dirname(database.path);
      const files = [database.path, `${database.path}-wal`, `${database.path}-shm`];
      const write = () =>
        writeAgent(({ db }) => {
          db.prepare("UPDATE schema_meta SET updated_at = updated_at + 1").run();
        }, options);

      fs.chmodSync(directory, 0o1700);
      fs.chmodSync(database.path, 0o4600);
      for (const file of files.slice(1)) {
        fs.chmodSync(file, 0o644);
      }
      write();
      expect(fs.statSync(database.path).mode & 0o7777).toBe(0o4600);
      closeAgents();
      openAgent(options);
      expect(fs.statSync(directory).mode & 0o7777).toBe(0o700);
      expect(fs.statSync(database.path).mode & 0o7777).toBe(0o600);
    },
  );

  it("opens when a transient sidecar disappears during permission repair", () => {
    const options = makeOptions();
    const database = openAgent(options);
    const journal = `${database.path}-journal`;
    closeAgents();
    fs.writeFileSync(journal, "", { mode: 0o644 });
    fs.chmodSync(journal, 0o644);
    chmodFailHook.removeTarget = journal;
    expect(openAgent(options).db.isOpen).toBe(true);
    expect(fs.existsSync(journal)).toBe(false);
  });
});
