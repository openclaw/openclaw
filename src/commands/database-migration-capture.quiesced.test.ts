import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDatabaseMigrationCapture } from "./database-migration-capture.js";

// mock-isolation: enter foreign-owner capture without discovering or acquiring host Gateway locks.
vi.mock("../cli/local-state-owner.js", () => ({
  runWithLocalStateOwner: async (options: {
    onForeignOwner: (scope: {
      env: NodeJS.ProcessEnv;
      signal: AbortSignal;
      assertCurrent: () => void;
    }) => Promise<unknown>;
  }) =>
    options.onForeignOwner({
      env: process.env,
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
}));
// mock-isolation: archive/snapshot proof fixes admission; the real lease owner is tested separately.
vi.mock("./database-migration-quiescence.js", () => ({
  withGatewayMigrationQuiescence: async (options: {
    run: (scope: {
      signal: AbortSignal;
      assertCurrent: () => void;
      revalidate: () => Promise<void>;
      owner: { ownerId: string; pid: number };
      expiresAtMs: number;
    }) => Promise<unknown>;
  }) =>
    options.run({
      signal: new AbortController().signal,
      assertCurrent() {},
      revalidate: async () => {},
      owner: { ownerId: "synthetic-source-owner", pid: 123 },
      expiresAtMs: Date.now() + 120_000,
    }),
}));

async function readFamily(filename: string) {
  return Promise.all(
    ["", "-wal", "-shm", "-journal"].map(async (suffix) => {
      try {
        const stat = await fs.stat(filename + suffix, { bigint: true });
        return {
          suffix,
          bytes: await fs.readFile(filename + suffix),
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtime: stat.mtimeNs,
          ctime: stat.ctimeNs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { suffix, missing: true };
        }
        throw error;
      }
    }),
  );
}

describe("externally quiesced exact capture", () => {
  it.each(["WAL", "DELETE"] as const)(
    "keeps the active %s source family unchanged",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        await state.writeConfig({
          plugins: { enabled: false },
          agents: { entries: { main: { workspace: state.workspaceDir } } },
        });
        const source = openOpenClawStateDatabase({ env: state.env });
        source.db.exec(
          "CREATE TABLE migration_quiesced_witness(value TEXT); INSERT INTO migration_quiesced_witness VALUES ('committed before suspension');",
        );
        await closeOpenClawStateDatabaseAsync();
        const sourcePath = state.statePath("state/openclaw.sqlite");
        const script = `const {DatabaseSync}=require('node:sqlite');
        const db=new DatabaseSync(process.argv[1]);
        db.exec('PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;');
        ${mode === "WAL" ? "db.exec(\"UPDATE migration_quiesced_witness SET value='committed in WAL'\");" : "db.exec(\"BEGIN IMMEDIATE; UPDATE migration_quiesced_witness SET value='not committed'\");"}
        process.stdin.resume(); process.stdin.on('end',()=>{${mode === "DELETE" ? "db.exec('ROLLBACK');" : ""}db.close();});
        process.stdout.write('ready\\n');`;
        const child = spawn(resolveTestNodeExecPath(), ["-e", script, sourcePath], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        const exited = once(child, "exit");
        try {
          const ready = await Promise.race([
            once(child.stdout, "data"),
            exited.then(([code]) => {
              throw new Error(`Synthetic writer exited before readiness: ${code}`);
            }),
          ]);
          expect(String(ready[0])).toBe("ready\n");
          const before = await readFamily(sourcePath);
          expect(
            before.find((entry) => entry.suffix === (mode === "WAL" ? "-wal" : "-journal")),
          ).not.toHaveProperty("missing");
          const capture = await createDatabaseMigrationCapture({
            externallyQuiesced: true,
            requestId: "synthetic-request",
            suspensionId: "synthetic-suspension",
            output: state.path("capsule"),
          });
          expect(capture).toMatchObject({
            ok: true,
            quiescence: {
              requestId: "synthetic-request",
              suspensionId: "synthetic-suspension",
              ownerId: "synthetic-source-owner",
              pid: 123,
            },
          });
          const after = await readFamily(sourcePath);
          for (const [index, observed] of after.entries()) {
            const previous = before[index]!;
            const { bytes: previousBytes, ...previousMetadata } = previous;
            const { bytes: observedBytes, ...observedMetadata } = observed;
            expect(observedMetadata, `${mode} ${observed.suffix || "main"} metadata`).toEqual(
              previousMetadata,
            );
            if (previousBytes && observedBytes) {
              expect(
                Buffer.compare(previousBytes, observedBytes),
                `${mode} ${observed.suffix || "main"} bytes`,
              ).toBe(0);
            }
          }
          const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"));
          const image = manifest.databases.find(
            (entry: { sourcePath: string }) => entry.sourcePath === sourcePath,
          );
          using db = new DatabaseSync(path.join(capture.directory, image.file), { readOnly: true });
          expect(db.prepare("SELECT value FROM migration_quiesced_witness").all()).toEqual([
            { value: mode === "WAL" ? "committed in WAL" : "committed before suspension" },
          ]);
        } finally {
          child.stdin.end();
          expect((await exited)[0]).toBe(0);
        }
      });
    },
  );

  it("refuses an arbitrary old base for the externally quiesced mode before any source work", async () => {
    await expect(
      createDatabaseMigrationCapture({
        externallyQuiesced: true,
        requestId: "request",
        suspensionId: "suspension",
        baseArchive: "/synthetic/old-base.tar.gz",
        output: "/synthetic/capsule",
      }),
    ).rejects.toThrow("creates its own filesystem base");
  });
});
