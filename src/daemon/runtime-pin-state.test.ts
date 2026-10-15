import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import * as sqliteRuntime from "../infra/bun-sqlite-library.js";
import * as sqliteSnapshots from "../infra/sqlite-snapshot-source.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { measureRuntimePinReadIo } from "./runtime-pin-state.io.test-support.js";
import {
  assertDaemonRuntimePinCurrent,
  commitDaemonRuntimePin,
  readDaemonRuntimePin,
  readDaemonRuntimePinForInstall,
} from "./runtime-pin-state.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const runtimePath = "/runtime tools/node";
const command = { programArguments: [runtimePath, "/app/openclaw.mjs", "gateway"] };
const pin = { runtime: "node" as const, path: runtimePath };
describe("transactional runtime pin state", () => {
  it.each(["gateway", "node"] as const)(
    "reads current %s pins from committed WAL without snapshot copies",
    async (kind) => {
      await withOpenClawTestState({ label: "runtime-pin-live" }, async (state) => {
        const scope = { kind, env: state.env, allowNativeRead: true as const };
        const pathname = state.statePath("state", "openclaw.sqlite");
        const empty = readDaemonRuntimePinForInstall(scope, null, true);
        assertDaemonRuntimePinCurrent(scope, empty);
        commitDaemonRuntimePin(scope, { expected: empty }, null);
        expect(fs.existsSync(pathname)).toBe(false);
        commitDaemonRuntimePin(scope, { expected: empty, pin }, command);
        await closeStateDatabaseForTest();

        const writer = new DatabaseSync(pathname);
        writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
        const row = writer
          .prepare(
            "SELECT state_key, value_json FROM config_machine_state WHERE state_key LIKE 'daemon-runtime-pin:%'",
          )
          .get() as { state_key: string; value_json: string };
        const nextPin = { runtime: "bun", path: "/runtime tools/bun" };
        const replacement = { ...JSON.parse(row.value_json), pin: nextPin };
        const snapshots = vi.spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocationSync");
        try {
          const expected = readDaemonRuntimePin(scope, command);
          for (let index = 0; index < 3; index += 1) {
            assertDaemonRuntimePinCurrent(scope, expected);
            expect(readDaemonRuntimePinForInstall(scope, command, true).revision).toBe(
              expected.revision,
            );
          }
          writer
            .prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
            .run(JSON.stringify(replacement), row.state_key);
          expect(() => assertDaemonRuntimePinCurrent(scope, expected)).toThrow(/changed/);
          expect(readDaemonRuntimePin(scope, command).pin).toEqual(nextPin);
          expect(() => commitDaemonRuntimePin(scope, { expected, pin }, command)).toThrow(
            /changed before persistence/,
          );
          await closeStateDatabaseForTest();
          expect(snapshots).not.toHaveBeenCalled();

          // Cold planning and explicit artifact scopes still preserve every source artifact.
          const artifacts = () =>
            ["", "-wal", "-shm"].map((suffix) => fs.readFileSync(pathname + suffix));
          const before = artifacts();
          expect(readDaemonRuntimePin({ kind, env: state.env }, command).pin).toEqual(nextPin);
          expect(
            withArtifactPreservingStateReads(() => readDaemonRuntimePin(scope, command)).pin,
          ).toEqual(nextPin);
          expect(snapshots).toHaveBeenCalledTimes(2);
          expect(artifacts()).toEqual(before);
        } finally {
          snapshots.mockRestore();
          writer.close();
          await closeStateDatabaseForTest();
        }
      });
    },
  );

  it("rejects a later pin even inside an inherited discovery snapshot", async () => {
    await withOpenClawTestState({ label: "runtime-pin-discovery" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, null), pin }, command);
      await closeStateDatabaseForTest();
      const writer = new DatabaseSync(state.statePath("state", "openclaw.sqlite"));
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
      try {
        await withOpenClawStateDatabaseReadSnapshot(
          async () => {
            const expected = readDaemonRuntimePin(scope, command);
            writer
              .prepare(
                "DELETE FROM config_machine_state WHERE state_key LIKE 'daemon-runtime-pin:%'",
              )
              .run();
            expect(readDaemonRuntimePin(scope, command)).toEqual(expected);
            expect(() => assertDaemonRuntimePinCurrent(scope, expected)).toThrow(/changed/);
            expect(readDaemonRuntimePin({ ...scope, allowNativeRead: true }, command).stored).toBe(
              false,
            );
            expect(readDaemonRuntimePin(scope, command)).toEqual(expected);
          },
          { env: state.env },
        );
      } finally {
        writer.close();
        await closeStateDatabaseForTest();
      }
    });
  });

  it.skipIf(process.platform !== "linux")(
    "keeps live guard syscall I/O bounded as allocated state grows from 16 to 64 MiB",
    async ({ signal }) => {
      type Sample = Awaited<ReturnType<typeof measureRuntimePinReadIo>> & {
        payloadMiB: number;
        live: boolean;
      };
      const samples: Sample[] = [];
      for (const payloadMiB of [16, 64]) {
        await withOpenClawTestState({ label: "runtime-pin-io" }, async (state) => {
          const scope = { kind: "gateway" as const, env: state.env };
          commitDaemonRuntimePin(
            scope,
            { expected: readDaemonRuntimePin(scope, null), pin },
            command,
          );
          const expected = readDaemonRuntimePin(scope, command);
          await closeStateDatabaseForTest();
          const pathname = state.statePath("state", "openclaw.sqlite");
          const writer = new DatabaseSync(pathname);
          try {
            writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
            // Random payload allocates real pages without adding a test-only schema surface.
            writer
              .prepare(
                "INSERT INTO config_machine_state VALUES ('runtime-pin-io-payload', '\"' || hex(randomblob(?)) || '\"', 0)",
              )
              .run((payloadMiB * 1024 ** 2) / 2);
            writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
            writer
              .prepare(
                "UPDATE config_machine_state SET updated_at_ms = 1 WHERE state_key LIKE 'daemon-runtime-pin:%'",
              )
              .run();
            expect(fs.statSync(pathname).blocks * 512).toBeGreaterThanOrEqual(
              payloadMiB * 1024 ** 2,
            );
            expect(fs.statSync(pathname + "-wal").size).toBeGreaterThan(32);
            for (const live of [false, true]) {
              const source = new URL("./runtime-pin-state.io.test-support.ts", import.meta.url)
                .href;
              let stdout = "";
              let stderr = "";
              const status = await runManagedCommand({
                bin: process.execPath,
                args: [
                  "--import",
                  new URL("../../scripts/tsx.mjs", import.meta.url).href,
                  "--input-type=module",
                  "--eval",
                  `import { measureRuntimePinReadIo } from ${JSON.stringify(source)};
                 console.log(JSON.stringify(await measureRuntimePinReadIo(${JSON.stringify({ command, expected, live })})));`,
                ],
                env: state.env,
                stdio: ["ignore", "pipe", "pipe"],
                timeoutMs: 60_000,
                signal,
                requireProcessTreeExit: true,
                onReady(child) {
                  child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
                  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
                },
              });
              expect(status, stderr).toBe(0);
              const sample: Sample = { payloadMiB, live, ...JSON.parse(stdout) };
              samples.push(sample);
              expect(sample.snapshotChildren).toBe(live ? 0 : 3);
              expect(sample.mmapBytes).toBe(0);
              expect(sample.io.rchar).toBeGreaterThanOrEqual(0);
              expect(sample.io.wchar).toBeGreaterThanOrEqual(0);
              if (live) {
                expect(sample.io.rchar).toBeLessThan(8 * 1024 ** 2);
                expect(sample.io.wchar).toBeLessThan(1024 ** 2);
              } else {
                expect(sample.io.rchar).toBeGreaterThan(payloadMiB * 1024 ** 2 * 3);
              }
            }
          } finally {
            writer.close();
            await closeStateDatabaseForTest();
          }
        });
      }
      // Keep the native counter evidence in Linux CI; these are syscall bytes, not disk traffic.
      console.info("runtime-pin guard I/O", JSON.stringify(samples));
      const [smallCold, smallLive, largeCold, largeLive] = samples;
      assert.ok(smallCold && smallLive && largeCold && largeLive);
      expect(largeLive.io.rchar - smallLive.io.rchar).toBeLessThan(1024 ** 2);
      expect(largeCold.io.rchar - smallCold.io.rchar).toBeGreaterThan(48 * 1024 ** 2 * 3);
    },
    120_000,
  );

  it("keeps absent/default state read-only and persists explicit intent across reopen", async () => {
    await withOpenClawTestState({ label: "runtime-pin" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const empty = readDaemonRuntimePin(scope, command);
      expect(empty.pin).toBeUndefined();
      expect(fs.existsSync(state.statePath("state", "openclaw.sqlite"))).toBe(false);
      commitDaemonRuntimePin(scope, { expected: empty, pin }, command);
      closeOpenClawStateDatabaseForTest();
      expect(readDaemonRuntimePin(scope, command).pin).toEqual(pin);
      expect(readDaemonRuntimePin({ ...scope, kind: "node" }, command).pin).toBeUndefined();
      expect(
        readDaemonRuntimePin(
          { ...scope, env: { ...state.env, OPENCLAW_PROFILE: "other" } },
          command,
        ).pin,
      ).toBeUndefined();
      expect(
        readDaemonRuntimePin(
          { ...scope, env: { ...state.env, OPENCLAW_CONFIG_PATH: state.path("other.json") } },
          command,
        ).pin,
      ).toBeUndefined();
    });
  });
  it("rejects stale plans and definition mismatch without adopting operator overrides", async () => {
    await withOpenClawTestState({ label: "runtime-pin-stale" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const original = readDaemonRuntimePin(scope, command);
      commitDaemonRuntimePin(scope, { expected: original, pin }, command);
      expect(() => assertDaemonRuntimePinCurrent(scope, original)).toThrow(/changed/);
      expect(() => commitDaemonRuntimePin(scope, { expected: original }, null)).toThrow(/changed/);
      const override = { programArguments: ["/operator/wrapper"], managedDefinition: command };
      expect(readDaemonRuntimePin(scope, override).pin).toEqual(pin);
      expect(() => readDaemonRuntimePin(scope, { programArguments: ["/different/node"] })).toThrow(
        /changed/,
      );
      expect(readDaemonRuntimePin(scope, null).pin).toBeUndefined();
      const explicit = readDaemonRuntimePinForInstall(scope, override, true);
      expect(explicit.pin).toBeUndefined();
      expect(explicit.revision).toBe(readDaemonRuntimePin(scope, override).revision);
      expect(explicit.definition).toBe(readDaemonRuntimePin(scope, override).definition);
      commitDaemonRuntimePin(scope, { expected: explicit }, null);
      expect(readDaemonRuntimePin(scope, command).stored).toBe(false);
    });
  });
  it("retains inactive wrapper pins separately and clears intent transactionally", async () => {
    await withOpenClawTestState({ label: "runtime-pin-wrapper" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      const wrapped = { programArguments: ["/wrapper", "gateway"] };
      const bun = { runtime: "bun" as const, path: "/runtime tools/bun" };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, null), pin: bun },
        wrapped,
      );
      expect(readDaemonRuntimePin(scope, wrapped).pin).toEqual(bun);
      const updated = { programArguments: [bun.path, "/new/openclaw.mjs", "gateway"] };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, wrapped), pin: bun },
        updated,
      );
      expect(readDaemonRuntimePin(scope, updated).pin).toEqual(bun);
      commitDaemonRuntimePin(scope, { expected: readDaemonRuntimePin(scope, updated) }, updated);
      expect(readDaemonRuntimePin(scope, updated).pin).toBeUndefined();
    });
  });
  it("propagates cold pin snapshot read failures without adopting absent state", async () => {
    await withOpenClawTestState({ label: "runtime-pin-read-failure" }, async (state) => {
      const scope = { kind: "gateway" as const, env: state.env };
      commitDaemonRuntimePin(
        scope,
        { expected: readDaemonRuntimePin(scope, command), pin },
        command,
      );
      await closeStateDatabaseForTest();
      const failure = Object.assign(new Error("pin snapshot read failed"), { code: "EIO" });
      const snapshot = vi
        .spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocationSync")
        .mockImplementationOnce(() => {
          throw failure;
        });
      try {
        expect(() => readDaemonRuntimePinForInstall(scope, command, false)).toThrow(failure);
        expect(snapshot).toHaveBeenCalledOnce();
      } finally {
        snapshot.mockRestore();
        await closeStateDatabaseForTest();
      }
    });
  });
  it.each([
    { capable: false, cleanup: "deferred", succeeds: true },
    { capable: true, cleanup: "deferred", succeeds: false },
    { capable: false, cleanup: "throws", succeeds: false },
  ] as const)(
    "reads persisted intent with $cleanup snapshot cleanup (native close capable: $capable)",
    async ({ capable, cleanup, succeeds }) => {
      await withOpenClawTestState({ label: "runtime-pin-cleanup" }, async (state) => {
        const scope = { kind: "gateway" as const, env: state.env };
        commitDaemonRuntimePin(
          scope,
          { expected: readDaemonRuntimePin(scope, command), pin },
          command,
        );
        await closeStateDatabaseForTest();

        const capabilities = sqliteRuntime.getSqliteRuntimeCapabilities();
        const runtime = vi.spyOn(sqliteRuntime, "getSqliteRuntimeCapabilities").mockReturnValue({
          ...capabilities,
          explicitSqliteCloseReleasesNativeResources: capable,
        });
        const prepare = sqliteSnapshots.prepareSqliteReadOnlyLocationSync;
        const cleanupFailure = new Error("required snapshot cleanup failed");
        let cleanupSnapshot: (() => boolean) | undefined;
        const snapshot = vi
          .spyOn(sqliteSnapshots, "prepareSqliteReadOnlyLocationSync")
          .mockImplementationOnce((pathname) => {
            const prepared = prepare(pathname);
            cleanupSnapshot = prepared.cleanup;
            return {
              ...prepared,
              cleanup: vi.fn(prepared.cleanup).mockImplementationOnce(() => {
                if (cleanup === "throws") {
                  throw cleanupFailure;
                }
                return false;
              }),
            };
          });
        try {
          const read = () => readDaemonRuntimePin(scope, command);
          if (succeeds) {
            expect(read()).toMatchObject({ stored: true, pin });
          } else {
            expect(read).toThrow(
              cleanup === "throws"
                ? cleanupFailure
                : "Shared-state snapshot cleanup is incomplete.",
            );
          }
        } finally {
          snapshot.mockRestore();
          runtime.mockRestore();
          cleanupSnapshot?.();
          await closeStateDatabaseForTest();
        }
      });
    },
  );
});
