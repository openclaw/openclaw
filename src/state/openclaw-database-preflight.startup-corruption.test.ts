import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeDatabases, databaseFixture } from "./database-preflight-fixtures.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabases();
});

// Keep the SQLite header so the open succeeds and the first schema read hits SQLITE_CORRUPT.
function corrupt(pathname: string) {
  const header = fs.readFileSync(pathname).subarray(0, 100);
  fs.writeFileSync(pathname, Buffer.concat([header, Buffer.alloc(4096, 0xde)]));
  for (const sidecar of [`${pathname}-wal`, `${pathname}-shm`, `${pathname}.seal`]) {
    fs.rmSync(sidecar, { force: true });
  }
}

it.each(["state", "agent"] as const)(
  "names the corrupt %s database when startup refuses it",
  async (kind) => {
    const fixture = databaseFixture(tempDirs.make(`startup-corrupt-${kind}-`));
    fixture.state();
    fixture.agent();
    closeDatabases();
    const pathname = kind === "state" ? fixture.statePath : fixture.agentPath();
    corrupt(pathname);

    const failure = await fixture.ready().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      `Gateway refused startup because persisted database readiness could not be verified:\n${kind} ${pathname}: database disk image is malformed`,
    );
    // Startup refusal classification still reads the native error through the cause chain.
    expect((failure as Error).cause).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 11 });
  },
);
