import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createManagedHandoffLeaseDatabase } from "./update-managed-service-handoff-database.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const databaseModule = new URL("./update-managed-service-handoff-database.ts", import.meta.url)
  .href;
const realSpawnSync = childProcess.spawnSync.bind(childProcess);
const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(path.resolve("scripts/tsx.mjs")).href;
let root: string;
let databasePath: string;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("handoff-publication-"));
  fs.chmodSync(root, 0o700);
  databasePath = path.join(root, "managed-update-handoffs.sqlite");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function insertRow(db: DatabaseSync, key: string, owner: string): void {
  db.prepare(
    "INSERT INTO managed_update_handoffs " +
      "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(key, owner, "{}", 1);
}

function readOwners(): string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare("SELECT owner FROM managed_update_handoffs ORDER BY owner")
      .all()
      .map((row) => String(row.owner));
  } finally {
    db.close();
  }
}

type RunningChild = {
  child: ReturnType<typeof spawn>;
  closed: Promise<unknown[]>;
  output: () => { stdout: string; stderr: string };
  waitForMarker: (marker: string) => Promise<void>;
};

function spawnFixture(script: string, args: string[] = []): RunningChild {
  const child = spawn(
    process.execPath,
    ["--no-warnings", "--import", tsxLoader, "--input-type=module", "--eval", script, ...args],
    { cwd: repoRoot, env: {}, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  void closed.catch(() => undefined);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = (stdout + chunk.toString()).slice(-64 * 1024);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-64 * 1024);
  });
  return {
    child,
    closed,
    output: () => ({ stdout, stderr }),
    waitForMarker: async (marker) => {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes(marker)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`fixture exited before ${marker}: ${JSON.stringify({ stdout, stderr })}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `fixture timed out before ${marker}: ${JSON.stringify({ stdout, stderr })}`,
          );
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    },
  };
}

async function killFixture(fixture: RunningChild): Promise<void> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGKILL");
  }
  await Promise.race([
    fixture.closed,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("fixture did not close after SIGKILL")), 5_000);
    }),
  ]);
}

describe("managed handoff database publication", () => {
  it("does not create a database for an absent read", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    expect(() => withDatabase(false, () => undefined)).toThrow();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("publishes a complete private single-link database", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (db) => insertRow(db, root, "first"));

    const stat = fs.statSync(databasePath);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(stat.nlink).toBe(1);
    expect(readOwners()).toEqual(["first"]);
    expect(fs.readdirSync(root)).toEqual([path.basename(databasePath)]);
  });

  it("recovers an existing private empty database through the existing DDL path", () => {
    fs.writeFileSync(databasePath, "", { mode: 0o600 });
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (db) => insertRow(db, root, "recovered"));
    expect(readOwners()).toEqual(["recovered"]);
  });

  it("preserves an existing malformed database", () => {
    const malformed = Buffer.from("not a sqlite database");
    fs.writeFileSync(databasePath, malformed, { mode: 0o600 });
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);

    expect(() => withDatabase(true, () => undefined)).toThrow();
    expect(fs.readFileSync(databasePath)).toEqual(malformed);
    expect(fs.statSync(databasePath).nlink).toBe(1);
  });

  it("leaves the canonical path absent when no-replace publication is unavailable", () => {
    vi.spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 1,
      output: [null, '{"ok":false,"code":"ENOTSUP","message":"unsupported"}', ""],
      stdout: '{"ok":false,"code":"ENOTSUP","message":"unsupported"}',
      stderr: "",
      status: 2,
      signal: null,
    });
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);

    expect(() => withDatabase(true, () => undefined)).toThrow("unsupported");
    expect(fs.existsSync(databasePath)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("never removes a published database after the publication helper reports failure", () => {
    vi.spyOn(childProcess, "spawnSync").mockImplementation((_command, args) => {
      const input = JSON.parse(String(args?.at(-1)));
      const source = String(input.sourcePath);
      const target = String(input.targetPath);
      fs.renameSync(source, target);
      const peer = new DatabaseSync(target);
      try {
        insertRow(peer, "peer", "peer");
      } finally {
        peer.close();
      }
      return {
        pid: 1,
        output: [null, '{"ok":false,"code":"EIO","message":"sync failed"}', ""],
        stdout: '{"ok":false,"code":"EIO","message":"sync failed"}',
        stderr: "",
        status: 2,
        signal: null,
      };
    });
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);

    expect(() => withDatabase(true, () => undefined)).toThrow("sync failed");
    expect(readOwners()).toEqual(["peer"]);
    expect(fs.statSync(databasePath).nlink).toBe(1);
    vi.restoreAllMocks();

    withDatabase(true, (db) => insertRow(db, "next", "next"));
    expect(readOwners()).toEqual(["next", "peer"]);
  });

  it.each(["source", "parent"] as const)(
    "refuses a replaced publication %s before the no-replace rename",
    (target) => {
      let retainedParent: string | undefined;
      vi.spyOn(childProcess, "spawnSync").mockImplementation((command, args, options) => {
        const input = JSON.parse(String(args?.at(-1)));
        if (target === "source") {
          fs.renameSync(input.sourcePath, input.sourcePath + ".retained");
          fs.writeFileSync(input.sourcePath, "replacement", { mode: 0o600 });
        } else {
          retainedParent = input.parentPath + ".retained";
          const stagingName = path.basename(path.dirname(input.sourcePath));
          fs.renameSync(input.parentPath, retainedParent);
          fs.mkdirSync(input.parentPath, { mode: 0o700 });
          fs.renameSync(
            path.join(retainedParent, stagingName),
            path.join(input.parentPath, stagingName),
          );
        }
        return realSpawnSync(command, args, options);
      });
      const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
      try {
        expect(() => withDatabase(true, () => undefined)).toThrow(
          "publication input identity changed",
        );
        expect(fs.existsSync(databasePath)).toBe(false);
      } finally {
        if (retainedParent) {
          fs.rmSync(retainedParent, { recursive: true, force: true });
        }
      }
    },
  );

  it("admits nested reads after first publication", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (writer) => {
      insertRow(writer, root, "writer");
      expect(
        withDatabase(false, (reader) =>
          reader.prepare("SELECT owner FROM managed_update_handoffs").get(),
        ),
      ).toEqual({ owner: "writer" });
    });
  });

  it("lets competing first writers converge on one complete database", async () => {
    const script = `
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      const withDatabase = createManagedHandoffLeaseDatabase(process.argv[1]);
      withDatabase(true, (db) => db.prepare(
        "INSERT INTO managed_update_handoffs " +
        "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run(process.argv[2], process.argv[2], "{}", 1));
      process.stdout.write("done");
    `;
    const first = spawnFixture(script, [databasePath, "first"]);
    const second = spawnFixture(script, [databasePath, "second"]);
    try {
      expect(await first.closed).toEqual([0, null]);
      expect(await second.closed).toEqual([0, null]);
      expect(first.output()).toEqual({ stdout: "done", stderr: "" });
      expect(second.output()).toEqual({ stdout: "done", stderr: "" });
      expect(readOwners()).toEqual(["first", "second"]);
      expect(fs.statSync(databasePath).nlink).toBe(1);
    } finally {
      await stopChildProcess(first.child, 5_000);
      await stopChildProcess(second.child, 5_000);
    }
  });

  it("never exposes an incomplete database to a real peer reader", async () => {
    const script = `
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      const withDatabase = createManagedHandoffLeaseDatabase(process.argv[1]);
      withDatabase(true, (db) => db.prepare(
        "INSERT INTO managed_update_handoffs " +
        "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run("writer", "writer", "{}", 1));
    `;
    const writer = spawnFixture(script, [databasePath]);
    let reads = 0;
    try {
      while (writer.child.exitCode === null && writer.child.signalCode === null) {
        if (fs.existsSync(databasePath)) {
          expect(() => {
            const reader = new DatabaseSync(databasePath, { readOnly: true });
            try {
              reader.exec("PRAGMA busy_timeout=5000");
              reader.prepare("SELECT install_root FROM managed_update_handoffs").all();
              const stat = fs.statSync(databasePath);
              if (process.platform !== "win32") {
                expect(stat.mode & 0o777).toBe(0o600);
              }
              expect(stat.nlink).toBe(1);
              reads += 1;
            } finally {
              reader.close();
            }
          }).not.toThrow();
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
      }
      expect(await writer.closed).toEqual([0, null]);
      expect(writer.output().stderr).toBe("");
      expect(readOwners()).toEqual(["writer"]);
      expect(reads).toBeGreaterThan(0);
    } finally {
      await stopChildProcess(writer.child, 5_000);
    }
  });

  it("recovers when the first writer crashes before publication", async () => {
    const script = `
      import childProcess from "node:child_process";
      import fs from "node:fs";
      childProcess.spawnSync = () => {
        fs.writeSync(1, "before-publication\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      createManagedHandoffLeaseDatabase(process.argv[1])(true, () => undefined);
    `;
    const writer = spawnFixture(script, [databasePath]);
    try {
      await writer.waitForMarker("before-publication");
      await killFixture(writer);
      expect(fs.existsSync(databasePath)).toBe(false);

      const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
      withDatabase(true, (db) => insertRow(db, root, "recovered"));
      expect(readOwners()).toEqual(["recovered"]);
    } finally {
      await stopChildProcess(writer.child, 5_000);
    }
  });

  it("preserves a committed row when its writer crashes afterward", async () => {
    const script = `
      import fs from "node:fs";
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      const withDatabase = createManagedHandoffLeaseDatabase(process.argv[1]);
      withDatabase(true, (db) => db.prepare(
        "INSERT INTO managed_update_handoffs " +
        "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run("committed", "committed", "{}", 1));
      fs.writeSync(1, "committed-and-closed\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `;
    const writer = spawnFixture(script, [databasePath]);
    try {
      await writer.waitForMarker("committed-and-closed");
      await killFixture(writer);
      expect(readOwners()).toEqual(["committed"]);

      const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
      withDatabase(true, (db) => insertRow(db, "next", "next"));
      expect(readOwners()).toEqual(["committed", "next"]);
    } finally {
      await stopChildProcess(writer.child, 5_000);
    }
  });
});
