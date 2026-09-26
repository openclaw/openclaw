import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import {
  assertReliabilityForcedExit,
  waitForReliabilityWorkerExit,
} from "../../scripts/lib/sqlite-reliability-process.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import * as nodeSqlite from "./node-sqlite.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import {
  readPackageActivationStatus,
  readPackageActivationReceipt,
  runPackageActivationRecovery,
  assertNoPendingPackageActivation,
} from "./package-update-activation.js";
import { createPackageIntegrityReader } from "./package-update-integrity.js";
import { swapStagedPackageInstall } from "./package-update-swap.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";

const fixtures = createPackageActivationLifetimeFixture();
const { lifetime, setup, prepare, spawnChild, stopChild, killUncommittedWrite } = fixtures;
let root: string;
let assertDatabasePath: (path: string) => void;
let childGuardEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
beforeEach(() => {
  ({ root, assertDatabasePath, childGuardEnv } = setup());
});
afterEach(async () => {
  try {
    await lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

describe.skipIf(process.platform === "win32")(
  "package activation custody and surviving completion",
  () => {
    it("keeps automatic retirement resumable after the previous package is removed", async () => {
      const f = await createPackageSwapFixture(root);
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const failure = new Error("retirement acknowledgement lost");
      const removeAnchor = fsp.rmdir.bind(fsp);
      let interrupted = false;
      const remove = vi.spyOn(fsp, "rmdir").mockImplementation(async (file, ...args) => {
        if (file === anchor) {
          expect(fs.existsSync(path.join(anchor, "previous"))).toBe(false);
          interrupted = true;
          throw failure;
        }
        return removeAnchor(file, ...args);
      });
      try {
        const result = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(f.packageRoot);
          return swapStagedPackageInstall({
            ...f.params,
            activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
          });
        });
        expect(interrupted).toBe(true);
        expect(result.status).toBe("failed");
        expect(result.step.stderrTail).toContain(failure.message);
        expect(result.step.stderrTail).toContain("Package retirement remains pending");
        expect(fs.readFileSync(path.join(f.packageRoot, "package.json"), "utf8")).toContain(
          '"version":"2.0.0"',
        );
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
        const record = openPackageActivationJournal(anchor).read();
        expect(record.phase).toBe("retiring");
        expect(record.intent).toMatchObject({ kind: "remove-anchor", selected: "candidate" });
        remove.mockRestore();
        await expect(
          runPackageActivationRecovery(anchor, "retire", record.descriptor.operationId),
        ).resolves.toMatchObject({ phase: "complete" });
        expect(fs.existsSync(anchor)).toBe(false);
        expect(fs.readFileSync(f.launcher, "utf8")).toBe("candidate launcher\n");
      } finally {
        remove.mockRestore();
      }
    });

    it("preserves version-1 launcher receipts with current structured metadata", async () => {
      const f = await prepare();
      const record = openPackageActivationJournal(f.anchor).read();
      const captured = await createPackageIntegrityReader().launcher(f.launcher);
      expect(record.descriptor.version).toBe(1);
      expect(record.descriptor.launchers[0]?.previous).toBe(
        JSON.stringify([
          captured.type,
          captured.mode,
          captured.uid,
          captured.gid,
          captured.contents,
        ]),
      );
      const journalPath = resolvePackageActivationJournalPath(f.anchor);
      const before = fs.readFileSync(journalPath);
      expect((await readPackageActivationStatus(f.anchor, f.operationId)).phase).toBe("prepared");
      expect(fs.readFileSync(journalPath)).toEqual(before);
      await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
      await runPackageActivationRecovery(f.anchor, "retire", f.operationId);
      expect((await readPackageActivationStatus(f.anchor, f.operationId)).phase).toBe("complete");
    });

    it("recovers the original operation after a killed uncommitted journal write", async () => {
      const fixture = await prepare();
      const journalPath = resolvePackageActivationJournalPath(fixture.anchor);
      const killed = killUncommittedWrite(journalPath);
      expect(killed.error, killed.stderr).toBeUndefined();
      assertReliabilityForcedExit(
        { code: killed.status, signal: killed.signal },
        "activation uncommitted journal",
      );
      const rollbackPath = `${journalPath}-journal`;
      expect(fs.statSync(rollbackPath).size).toBeGreaterThan(512);
      const rollback = fs.readFileSync(rollbackPath);
      await expect(
        readPackageActivationStatus(fixture.anchor, fixture.operationId),
      ).rejects.toThrow();
      await expect(
        runPackageActivationRecovery(fixture.anchor, "repair", randomUUID()),
      ).rejects.toThrow("different operation");
      expect(fs.readFileSync(rollbackPath)).toEqual(rollback);
      await expect(
        runPackageActivationRecovery(fixture.anchor, "repair", fixture.operationId),
      ).resolves.toMatchObject({ operationId: fixture.operationId });
      expect(fs.existsSync(rollbackPath)).toBe(false);
      await expect(
        runPackageActivationRecovery(fixture.anchor, "retire", fixture.operationId),
      ).resolves.toMatchObject({ phase: "complete" });
    });

    it("preserves local overrides from the activation-owned displaced tree", async () => {
      const f = await createPackageSwapFixture(root);
      await fsp.mkdir(path.join(f.packageRoot, "dist"), { recursive: true });
      await fixtures.writePostCoreCapability(f.params.stage.packageRoot);
      const edited = path.join(f.packageRoot, "dist/local.js");
      await fsp.writeFile(edited, "upstream\n");
      await writePackageDistInventory(f.packageRoot);
      await fsp.writeFile(edited, "operator edit\n");
      let saved: string | undefined;
      let prepared = false;
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(f.packageRoot);
        const result = await swapStagedPackageInstall({
          ...f.params,
          activation: {
            fence,
            nodeRunner: process.execPath,
            onPrepared: () => {
              prepared = true;
            },
          },
          localOverrides: {
            reapply: false,
            env: { ...process.env, HOME: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
          },
          onLocalOverrides: (overrides) => {
            saved = overrides.recoveryDir;
          },
        });
        expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      });
      expect(prepared).toBe(true);
      expect(fs.existsSync(resolvePackageActivationAnchor(f.packageRoot))).toBe(false);
      expect(saved).toBeDefined();
      expect(await fsp.readFile(path.join(saved!, "files/dist/local.js"), "utf8")).toBe(
        "operator edit\n",
      );
    });

    it.each(["contents", "mode"] as const)(
      "retains recovery assets when an aborted launcher changes %s in place",
      async (change) => {
        const f = await prepare();
        await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
        const journalPath = resolvePackageActivationJournalPath(f.anchor);
        const before = fs.readFileSync(journalPath);
        const inode = fs.lstatSync(f.launcher).ino;
        if (change === "contents") {
          fs.writeFileSync(f.launcher, "external edit\n");
        } else {
          fs.chmodSync(f.launcher, 0o700);
        }
        expect(fs.lstatSync(f.launcher).ino).toBe(inode);
        await expect(
          runPackageActivationRecovery(f.anchor, "retire", f.operationId),
        ).rejects.toThrow(/launcher/i);
        expect(fs.readFileSync(journalPath)).toEqual(before);
        expect(fs.existsSync(path.join(f.anchor, "candidate"))).toBe(true);
        expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(true);
      },
    );

    it("exposes the durable staged helper after replacement acknowledgement loss", async () => {
      const first = await prepare();
      await runPackageActivationRecovery(first.anchor, "repair", first.operationId);
      await runPackageActivationRecovery(first.anchor, "retire", first.operationId);
      const journalPath = resolvePackageActivationJournalPath(first.anchor);
      const open = nodeSqlite.openNodeSqliteDatabase;
      let lost = false;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
        const db = open(file, options);
        if (db.location() === journalPath) {
          const exec = db.exec.bind(db);
          db.exec = (statement) => {
            exec(statement);
            if (!lost && statement === "COMMIT") {
              lost = true;
              throw new Error("replacement acknowledgement lost");
            }
          };
        }
        return db;
      });
      await expect(prepare()).rejects.toThrow("replacement acknowledgement lost");
      vi.mocked(nodeSqlite.openNodeSqliteDatabase).mockRestore();
      expect(lost).toBe(true);
      const record = openPackageActivationJournal(first.anchor).read();
      expect(record.descriptor.operationId).not.toBe(first.operationId);
      expect(record.phase).toBe("preparing");
      const helper = record.descriptor.preparation.find((entry) => entry.name === "helper")!.source;
      expect(fs.existsSync(helper)).toBe(true);
      expect(fs.existsSync(resolvePackageActivationHelper(first.anchor))).toBe(false);
      const before = fs.readFileSync(journalPath);
      const receipt = readPackageActivationReceipt(first.packageRoot);
      expect(receipt?.recoveryCommand).toContain(helper);
      expect(receipt?.recoveryCommand).toContain(record.descriptor.operationId);
      expect(() => assertNoPendingPackageActivation(first.packageRoot)).toThrow(helper);
      expect(fs.readFileSync(journalPath)).toEqual(before);
      await runPackageActivationRecovery(first.anchor, "repair", record.descriptor.operationId);
      await runPackageActivationRecovery(first.anchor, "retire", record.descriptor.operationId);
      expect(readPackageActivationReceipt(first.packageRoot)?.recoveryCommand).toBeUndefined();
    });

    it.for(["created", "schema", "inserted", "before-publication", "after-publication"])(
      "survives actual process death at first-use %s",
      { timeout: 120_000 },
      async (cut, { signal }) =>
        lifetime.run(async () => {
          signal.throwIfAborted();
          const fixture = await createPackageSwapFixture(root);
          const authority = await withUpdateCommandExecutor(randomUUID(), async (executor) =>
            captureUpdateCommandExecutorAuthority(await executor.enter(fixture.packageRoot)),
          );
          assertDatabasePath(authority.databasePath);
          const anchor = resolvePackageActivationAnchor(fixture.packageRoot);
          const child = spawnChild([cut, root, JSON.stringify(authority)]);
          const closed = once(child, "close");
          void closed.catch(() => {});
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout = (stdout + String(chunk)).slice(-8192);
          });
          child.stderr.on("data", (chunk) => {
            stderr = (stderr + String(chunk)).slice(-8192);
          });
          const abort = () => {
            child.kill("SIGKILL");
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const exit = await waitForReliabilityWorkerExit(
              child,
              `Package bootstrap child did not reach ${cut}: ${stderr}`,
            );
            await closed;
            signal.throwIfAborted();
            assertReliabilityForcedExit(exit, `package bootstrap ${cut}: ${stderr}`);
            expect(JSON.parse(stdout.trim())).toEqual({ cut, pid: child.pid });
            expect(fs.readFileSync(fixture.launcher, "utf8")).toBe("old launcher\n");
            expect(
              JSON.parse(fs.readFileSync(path.join(fixture.packageRoot, "package.json"), "utf8"))
                .version,
            ).toBe("1.0.0");
            if (cut !== "after-publication") {
              expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
              expect(() => assertNoPendingPackageActivation(fixture.packageRoot)).not.toThrow();
              await withUpdateCommandExecutor(
                randomUUID(),
                async (executor) => {
                  (await executor.enter(fixture.packageRoot)).assertCurrent();
                },
                { existingAuthority: authority },
              );
            } else {
              const record = openPackageActivationJournal(anchor).read();
              const helper = resolvePackageActivationHelper(anchor);
              expect(record.intent).toEqual({
                kind: "prepare",
                completed: ["helper"],
                moving: null,
              });
              expect(record.descriptor.authority).toMatchObject({
                ...authority,
                owner: expect.any(String),
              });
              expect(record.descriptor.authority.owner).not.toBe(authority.owner);
              expect(record.descriptor.journalParentIdentity).toBe(
                `${fs.statSync(path.dirname(helper)).dev}:${fs.statSync(path.dirname(helper)).ino}`,
              );
              expect(createHash("sha256").update(fs.readFileSync(helper)).digest("hex")).toBe(
                record.descriptor.helperDigest,
              );
              expect(fs.statSync(helper).mode & 0o077).toBe(0);
              expect(fs.statSync(resolvePackageActivationJournalPath(anchor)).mode & 0o077).toBe(0);
              expect(() => assertNoPendingPackageActivation(fixture.packageRoot)).toThrow(
                "incomplete",
              );
              for (const [action, phase] of [
                ["status", "preparing"],
                ["repair", "aborted"],
                ["retire", "complete"],
              ]) {
                assertDatabasePath(record.descriptor.authority.databasePath);
                const result = spawnSync(
                  process.execPath,
                  [
                    helper,
                    "--anchor",
                    anchor,
                    "--operation",
                    record.descriptor.operationId,
                    action!,
                  ],
                  {
                    encoding: "utf8",
                    timeout: 30_000,
                    env: childGuardEnv({ ...process.env, HOME: root, USERPROFILE: root }),
                  },
                );
                expect(result.error).toBeUndefined();
                expect(result.status, result.stderr).toBe(0);
                expect(JSON.parse(result.stdout)).toMatchObject({
                  operationId: record.descriptor.operationId,
                  phase,
                });
              }
            }
          } finally {
            signal.removeEventListener("abort", abort);
            await stopChild(child, closed);
          }
        }),
    );
    it.for(
      ["transition", "replacement"].flatMap((operation) =>
        ["after-update", "before-commit", "after-commit"].map((boundary) => ({
          operation,
          boundary,
          cut: `${operation}-${boundary}`,
        })),
      ),
    )(
      "preserves the one-slot receipt after actual process death at $cut",
      { timeout: 120_000 },
      async ({ operation, boundary, cut }, { signal }) =>
        lifetime.run(async () => {
          signal.throwIfAborted();
          const f = await prepare();
          if (operation === "replacement") {
            await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
            await runPackageActivationRecovery(f.anchor, "retire", f.operationId);
          }
          const journal = openPackageActivationJournal(f.anchor);
          const before = journal.read();
          assertDatabasePath(before.descriptor.authority.databasePath);
          const journalPath = resolvePackageActivationJournalPath(f.anchor);
          const identity = fs.statSync(journalPath, { bigint: true });
          const previousPackage = fs.readFileSync(path.join(f.packageRoot, "package.json"));
          const previousLauncher = fs.readFileSync(f.launcher);
          const child = spawnChild([
            cut,
            root,
            JSON.stringify(before.descriptor.authority),
            JSON.stringify(before),
          ]);
          const closed = once(child, "close");
          void closed.catch(() => {});
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout = (stdout + String(chunk)).slice(-8192);
          });
          child.stderr.on("data", (chunk) => {
            stderr = (stderr + String(chunk)).slice(-8192);
          });
          const abort = () => {
            child.kill("SIGKILL");
          };
          signal.addEventListener("abort", abort, { once: true });
          try {
            const exit = await waitForReliabilityWorkerExit(
              child,
              `Later journal cut ${cut}: ${stderr}`,
            );
            await closed;
            signal.throwIfAborted();
            assertReliabilityForcedExit(exit, `later journal ${cut}: ${stderr}`);
            expect(JSON.parse(stdout.trim())).toEqual({ cut, pid: child.pid });
            const snapshot = () => fixtures.snapshotControl(f.anchor);
            const afterDeath = snapshot();
            // Read-only observation must not play back a hot journal or clear sidecars.
            // A native refusal is a failure here, not implicit repair or an alternate pass.
            const after = openPackageActivationJournal(f.anchor).read();
            expect(fs.statSync(journalPath, { bigint: true })).toMatchObject({
              dev: identity.dev,
              ino: identity.ino,
            });
            expect(after.descriptor.journalIdentity).toBe(before.descriptor.journalIdentity);
            if (boundary !== "after-commit") {
              expect(after).toEqual(before);
            } else {
              expect(after.revision).toBe(before.revision + 1);
              expect(() => journal.assertCurrent(before)).toThrow("no longer current");
              if (operation === "transition") {
                expect(after).toEqual({
                  ...before,
                  revision: before.revision + 1,
                  phase: "publishing",
                  intent: { kind: "displace" },
                });
              } else {
                expect(after.descriptor.operationId).not.toBe(before.descriptor.operationId);
                expect(after.descriptor.authority).toMatchObject({
                  databasePath: before.descriptor.authority.databasePath,
                  databaseIdentity: before.descriptor.authority.databaseIdentity,
                  parentIdentity: before.descriptor.authority.parentIdentity,
                  installKey: before.descriptor.authority.installKey,
                });
                expect(after.descriptor.authority.owner).not.toBe(
                  before.descriptor.authority.owner,
                );
                expect(after).toMatchObject({
                  phase: "preparing",
                  intent: { kind: "prepare", completed: [], moving: null },
                  publications: [],
                });
                await expect(
                  readPackageActivationStatus(f.anchor, before.descriptor.operationId),
                ).rejects.toThrow("different operation");
              }
            }
            const expectedPhase =
              operation === "replacement" && boundary !== "after-commit" ? "complete" : after.phase;
            await expect(
              readPackageActivationStatus(f.anchor, after.descriptor.operationId),
            ).resolves.toMatchObject({
              phase: expectedPhase,
              operationId: after.descriptor.operationId,
            });
            await expect(
              runPackageActivationRecovery(f.anchor, "repair", randomUUID()),
            ).rejects.toThrow("different operation");
            const database = new DatabaseSync(journalPath, { readOnly: true });
            try {
              expect(database.prepare("SELECT slot FROM package_activation").all()).toEqual([
                { slot: 1 },
              ]);
            } finally {
              database.close();
            }
            expect(snapshot()).toEqual(afterDeath);
            expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(
              previousPackage,
            );
            expect(fs.readFileSync(f.launcher)).toEqual(previousLauncher);
            await withUpdateCommandExecutor(
              randomUUID(),
              async (executor) => {
                (await executor.enter(f.packageRoot)).assertCurrent();
              },
              { existingAuthority: after.descriptor.authority },
            );
          } finally {
            signal.removeEventListener("abort", abort);
            await stopChild(child, closed);
          }
        }),
    );
    it("does not create recovery artifacts when the sealed helper preflight fails", async () => {
      fs.unlinkSync(path.join(root, "sealed.mjs"));
      let anchor = "";
      await expect(
        prepare((selected) => {
          anchor = selected;
        }),
      ).rejects.toThrow("ENOENT");
      for (const file of [anchor, resolvePackageActivationControl(anchor)]) {
        expect(fs.lstatSync(file, { throwIfNoEntry: false })).toBeUndefined();
      }
    });

    it("does not treat a dangling foreign receipt link as absence", async () => {
      const f = await createPackageSwapFixture(root);
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const receipt = resolvePackageActivationControl(anchor);
      fs.symlinkSync(path.join(root, "missing"), receipt);
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).toThrow("recovery artifacts");
      expect(fs.lstatSync(receipt).isSymbolicLink()).toBe(true);
    });

    it.each(["fstat", "foreign-entry"])(
      "keeps a private %s failure unpublished and closes its descriptor",
      async (cut) => {
        const open = fs.openSync.bind(fs);
        const close = fs.closeSync.bind(fs);
        const fstat = fs.fstatSync.bind(fs);
        let descriptor: number | undefined;
        let privateFile = "";
        let closed = false;
        let anchor = "";
        const custody = vi.fn();
        const openSpy = vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
          const fd = open(file, flags, mode);
          if (flags === "wx" && String(file).endsWith("/operation.sqlite")) {
            descriptor = fd;
            privateFile = String(file);
          }
          return fd;
        });
        const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
          if (cut === "fstat" && args[0] === descriptor && !closed) {
            throw new Error("private fstat refused");
          }
          return fstat(...args);
        });
        const closeSpy = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
          close(fd);
          if (fd === descriptor && !closed) {
            closed = true;
            if (cut === "foreign-entry") {
              fs.writeFileSync(path.join(path.dirname(privateFile), "foreign"), "retain");
            }
          }
        });
        try {
          await expect(
            prepare((value) => {
              anchor = value;
            }, custody),
          ).rejects.toThrow(cut === "fstat" ? "private fstat refused" : "unknown objects");
          expect(descriptor).toBeTypeOf("number");
          expect(closed).toBe(true);
          expect(() => fstat(descriptor!)).toThrow();
          expect(custody).not.toHaveBeenCalled();
          expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
          if (cut === "foreign-entry") {
            expect(fs.readFileSync(path.join(path.dirname(privateFile), "foreign"), "utf8")).toBe(
              "retain",
            );
          }
        } finally {
          closeSpy.mockRestore();
          fstatSpy.mockRestore();
          openSpy.mockRestore();
        }
      },
    );

    it("rechecks the live installation after notifying the cleanup owner", async () => {
      let anchor = "";
      let changed = false;
      await expect(
        prepare(
          (value) => {
            anchor = value;
          },
          (retained) => {
            if (!retained) {
              return;
            }
            const live = path.join(path.dirname(anchor), "openclaw");
            fs.renameSync(live, `${live}.original`);
            fs.mkdirSync(live, { mode: 0o700 });
            changed = true;
          },
        ),
      ).rejects.toThrow("identity changed");
      expect(changed).toBe(true);
      expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
      expect(fs.readdirSync(path.join(path.dirname(anchor), "openclaw"))).toEqual([]);
    });

    it("has durable exact custody and a transfer intent before the first staged rename", async () => {
      const rename = fsp.rename.bind(fsp);
      let observed = false;
      await prepare((anchor) => {
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          if (to === path.join(anchor, "candidate")) {
            const record = openPackageActivationJournal(anchor).read();
            expect(record.phase).toBe("preparing");
            expect(record.intent).toMatchObject({ kind: "prepare", moving: "candidate" });
            expect(record.descriptor.candidate.identity).toBe(
              `${fs.lstatSync(from).dev}:${fs.lstatSync(from).ino}`,
            );
            observed = true;
          }
          await rename(from, to);
        });
      });
      expect(observed).toBe(true);
    });

    it("retains positive completion outside the anchor and remains readable after helper removal", async () => {
      const f = await prepare();
      await expect(
        runPackageActivationRecovery(f.anchor, "repair", f.operationId),
      ).resolves.toMatchObject({
        phase: "aborted",
      });
      await expect(
        runPackageActivationRecovery(f.anchor, "retire", f.operationId),
      ).resolves.toMatchObject({
        phase: "complete",
      });
      expect(fs.existsSync(f.anchor)).toBe(false);
      expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(false);
      await expect(readPackageActivationStatus(f.anchor, f.operationId)).resolves.toMatchObject({
        phase: "complete",
      });
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
      expect(fs.readFileSync(f.launcher, "utf8")).toBe("old launcher\n");
    });
    it.each(["candidate", "launchers"])(
      "reconciles lost %s transfer acknowledgement without adopting another object",
      async (name) => {
        const failure = new Error("transfer acknowledgement lost");
        let selectedAnchor = "";
        const rename = fsp.rename.bind(fsp);
        let cut = false;
        await expect(
          prepare((anchor) => {
            selectedAnchor = anchor;
            vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
              await rename(from, to);
              if (!cut && to === path.join(anchor, name)) {
                cut = true;
                throw failure;
              }
            });
          }),
        ).rejects.toBe(failure);
        expect(cut).toBe(true);
        vi.mocked(fsp.rename).mockRestore();
        const recorded = openPackageActivationJournal(selectedAnchor).read();
        expect(recorded.intent).toMatchObject({ kind: "prepare", moving: name });
        await expect(
          runPackageActivationRecovery(selectedAnchor, "repair", recorded.descriptor.operationId),
        ).resolves.toMatchObject({
          phase: "aborted",
        });
        await expect(
          runPackageActivationRecovery(selectedAnchor, "retire", recorded.descriptor.operationId),
        ).resolves.toMatchObject({
          phase: "complete",
        });
      },
    );

    it.each(["anchor-before", "anchor-after", "helper-before", "helper-after"])(
      "recovers the exact %s terminal cut",
      async (cut) => {
        const f = await prepare();
        await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
        const failure = new Error(cut);
        const removeAnchor = fsp.rmdir.bind(fsp);
        const unlink = fsp.unlink.bind(fsp);
        let interrupted = false;
        vi.spyOn(fsp, "rmdir").mockImplementation(async (file, ...args) => {
          if (file === f.anchor && cut.startsWith("anchor")) {
            interrupted = true;
            if (cut === "anchor-after") {
              await removeAnchor(file, ...args);
            }
            throw failure;
          }
          await removeAnchor(file, ...args);
        });
        vi.spyOn(fsp, "unlink").mockImplementation(async (file) => {
          if (file === resolvePackageActivationHelper(f.anchor) && cut.startsWith("helper")) {
            const record = openPackageActivationJournal(f.anchor).read();
            expect(record.phase).toBe("anchor-retired");
            expect(record.intent).toMatchObject({
              kind: "unlink-helper",
              identity: record.descriptor.helperIdentity,
            });
            interrupted = true;
            if (cut === "helper-after") {
              await unlink(file);
            }
            throw failure;
          }
          await unlink(file);
        });
        await expect(runPackageActivationRecovery(f.anchor, "retire", f.operationId)).rejects.toBe(
          failure,
        );
        expect(interrupted).toBe(true);
        vi.mocked(fsp.rmdir).mockRestore();
        vi.mocked(fsp.unlink).mockRestore();
        await expect(
          runPackageActivationRecovery(f.anchor, "retire", f.operationId),
        ).resolves.toMatchObject({
          phase: "complete",
        });
        await expect(readPackageActivationStatus(f.anchor, f.operationId)).resolves.toMatchObject({
          phase: "complete",
        });
        expect(fs.existsSync(f.anchor)).toBe(false);
      },
    );

    it("refuses a byte-equal replacement helper and preserves unknown anchor objects", async () => {
      const f = await prepare();
      await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
      const helper = resolvePackageActivationHelper(f.anchor);
      const saved = `${helper}.saved`;
      fs.renameSync(helper, saved);
      fs.copyFileSync(saved, helper);
      await expect(runPackageActivationRecovery(f.anchor, "retire", f.operationId)).rejects.toThrow(
        "helper identity changed",
      );
      expect(fs.existsSync(f.anchor)).toBe(true);
      fs.unlinkSync(helper);
      fs.renameSync(saved, helper);
      const unknown = path.join(f.anchor, "foreign");
      fs.writeFileSync(unknown, "keep");
      await expect(runPackageActivationRecovery(f.anchor, "retire", f.operationId)).rejects.toThrow(
        "Unknown",
      );
      expect(fs.readFileSync(unknown, "utf8")).toBe("keep");
    });

    it.each([
      "staged-anchor",
      "staged-helper",
      "stable-anchor",
      "stable-helper",
      "before-commit",
      "after-commit",
    ])(
      "keeps operation A complete or operation B recoverable after %s replacement cut",
      async (cut) => {
        const first = await prepare();
        await runPackageActivationRecovery(first.anchor, "repair", first.operationId);
        await runPackageActivationRecovery(first.anchor, "retire", first.operationId);
        const before = openPackageActivationJournal(first.anchor).read();
        const failure = new Error(cut);
        const mkdir = fsp.mkdtemp.bind(fsp);
        const write = fs.writeFileSync.bind(fs);
        const rename = fsp.rename.bind(fsp);
        const open = nodeSqlite.openNodeSqliteDatabase;
        let fired = false;
        vi.spyOn(fsp, "mkdtemp").mockImplementation(async (prefix, options) => {
          const created = await mkdir(prefix, options);
          if (!fired && cut === "staged-anchor" && prefix.includes(".activation-anchor-")) {
            fired = true;
            throw failure;
          }
          return created;
        });
        vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
          write(file, data, options);
          if (
            !fired &&
            cut === "staged-helper" &&
            String(file).includes(".activation-anchor-") &&
            String(file).endsWith(".recovery.mjs")
          ) {
            fired = true;
            throw failure;
          }
        });
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          await rename(from, to);
          if (
            !fired &&
            ((cut === "stable-anchor" && to === first.anchor) ||
              (cut === "stable-helper" && to === resolvePackageActivationHelper(first.anchor)))
          ) {
            fired = true;
            throw failure;
          }
        });
        vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
          const db = open(file, options);
          if (db.location() === resolvePackageActivationJournalPath(first.anchor)) {
            const exec = db.exec.bind(db);
            db.exec = (statement) => {
              if (!fired && statement === "COMMIT" && cut === "before-commit") {
                fired = true;
                throw failure;
              }
              exec(statement);
              if (!fired && statement === "COMMIT" && cut === "after-commit") {
                fired = true;
                throw failure;
              }
            };
          }
          return db;
        });
        await expect(prepare()).rejects.toBe(failure);
        expect(fired).toBe(true);
        vi.mocked(fsp.mkdtemp).mockRestore();
        vi.mocked(fs.writeFileSync).mockRestore();
        vi.mocked(fsp.rename).mockRestore();
        vi.mocked(nodeSqlite.openNodeSqliteDatabase).mockRestore();
        const after = openPackageActivationJournal(first.anchor).read();
        if (["staged-anchor", "staged-helper", "before-commit"].includes(cut)) {
          expect(after).toEqual(before);
          await expect(
            readPackageActivationStatus(first.anchor, first.operationId),
          ).resolves.toMatchObject({
            phase: "complete",
          });
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).not.toThrow();
          await expect(
            runPackageActivationRecovery(first.anchor, "retire", first.operationId),
          ).resolves.toMatchObject({
            phase: "complete",
          });
        } else {
          expect(after.descriptor.operationId).not.toBe(before.descriptor.operationId);
          expect(after.phase).toBe("preparing");
          expect(() => assertNoPendingPackageActivation(first.packageRoot)).toThrow("incomplete");
          await expect(
            runPackageActivationRecovery(first.anchor, "repair", after.descriptor.operationId),
          ).resolves.toMatchObject({
            phase: "aborted",
          });
          await expect(
            runPackageActivationRecovery(first.anchor, "retire", after.descriptor.operationId),
          ).resolves.toMatchObject({
            phase: "complete",
          });
        }
      },
    );

    it("reads completion through the actual status command after the helper is removed", async () => {
      const f = await prepare();
      await runPackageActivationRecovery(f.anchor, "repair", f.operationId);
      await runPackageActivationRecovery(f.anchor, "retire", f.operationId);
      const shared = await import("../cli/update-cli/shared.js");
      const config = await import("../config/config.js");
      const diagnostics = await import("../commands/node-runtime-diagnostics.js");
      const checks = await import("./update-check.js");
      const runs = await import("./update-run-status.js");
      const { defaultRuntime } = await import("../runtime.js");
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(f.packageRoot);
      vi.spyOn(config, "readSourceConfigBestEffort").mockResolvedValue({});
      vi.spyOn(diagnostics, "collectNodeRuntimeFindings").mockResolvedValue([]);
      vi.spyOn(checks, "checkUpdateStatus").mockResolvedValue({
        root: f.packageRoot,
        installKind: "package",
        packageManager: "npm",
      });
      vi.spyOn(runs, "readUpdateRunStatus").mockReturnValue({});
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const { updateStatusCommand } = await import("../cli/update-cli/status.js");
      await updateStatusCommand({ json: true });
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({
          packageActivation: expect.objectContaining({ phase: "complete" }),
        }),
      );
      expect(fs.existsSync(resolvePackageActivationHelper(f.anchor))).toBe(false);
    });

    it.each(["after-custody", "before-replacement", "before-control", "after-control"])(
      "preserves the actual stage-finally custody boundary on %s failure",
      async (cut) => {
        const f = await createPackageSwapFixture(root);
        const anchor = resolvePackageActivationAnchor(f.packageRoot);
        if (!cut.endsWith("control")) {
          const previous = await prepare();
          await runPackageActivationRecovery(anchor, "repair", previous.operationId);
          await runPackageActivationRecovery(anchor, "retire", previous.operationId);
        }
        const { runGlobalPackageUpdateSteps } = await import("./package-update-steps.js");
        const { createRootRunner, writePackageRoot } =
          await import("./package-update-steps.test-support.js");
        const capability = await import("./update-post-core-capability.js");
        vi.spyOn(capability, "supportsPostCoreExecutor").mockResolvedValue(true);
        const failure = new Error(cut);
        const rename = fsp.rename.bind(fsp);
        const renameControl = fs.renameSync.bind(fs);
        const open = nodeSqlite.openNodeSqliteDatabase;
        let fired = false;
        let stagePrefix = "";
        vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
          await rename(from, to);
          if (!fired && cut === "after-custody" && to === anchor) {
            fired = true;
            throw failure;
          }
        });
        vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
          const selected = !fired && to === resolvePackageActivationControl(anchor);
          if (selected && cut === "before-control") {
            fired = true;
            throw failure;
          }
          renameControl(from, to);
          if (selected && cut === "after-control") {
            fired = true;
            throw failure;
          }
        });
        vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((file, options) => {
          const db = open(file, options);
          if (db.location() === resolvePackageActivationJournalPath(anchor)) {
            const exec = db.exec.bind(db);
            db.exec = (statement) => {
              if (!fired && cut === "before-replacement" && statement === "COMMIT") {
                fired = true;
                throw failure;
              }
              exec(statement);
            };
          }
          return db;
        });
        const result = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
          const fence = await executor.enter(f.packageRoot);
          return runGlobalPackageUpdateSteps({
            installTarget: f.params.installTarget,
            installSpec: "openclaw@2.0.0",
            packageName: "openclaw",
            packageRoot: f.packageRoot,
            runCommand: createRootRunner(f.globalRoot),
            timeoutMs: 5000,
            activation: { fence, nodeRunner: process.execPath, onPrepared: () => {} },
            runStep: async ({ name, argv, cwd }) => {
              if (name !== "package-install") {
                throw new Error(`unexpected package-manager leaf ${name}`);
              }
              const prefix = argv[argv.indexOf("--prefix") + 1];
              if (!prefix) {
                throw new Error("No private staging prefix");
              }
              stagePrefix = prefix;
              await writePackageRoot(path.join(prefix, "lib", "node_modules", "openclaw"), "2.0.0");
              await fsp.mkdir(path.join(prefix, "bin"), { recursive: true });
              await fsp.writeFile(path.join(prefix, "bin", "openclaw"), "candidate launcher\n");
              return {
                name,
                command: argv.join(" "),
                cwd: cwd ?? root,
                durationMs: 0,
                exitCode: 0,
              };
            },
          });
        });
        expect(fired).toBe(true);
        expect(result.failedStep?.stderrTail).toContain(cut);
        vi.mocked(fsp.rename).mockRestore();
        vi.mocked(fs.renameSync).mockRestore();
        vi.mocked(nodeSqlite.openNodeSqliteDatabase).mockRestore();
        const retained = cut === "after-custody" || cut === "after-control";
        expect(fs.existsSync(stagePrefix)).toBe(retained);
        if (cut === "before-control") {
          expect(fs.existsSync(resolvePackageActivationControl(anchor))).toBe(false);
          expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
          return;
        }
        const operationId = openPackageActivationJournal(anchor).read().descriptor.operationId;
        if (retained) {
          await runPackageActivationRecovery(anchor, "repair", operationId);
          await runPackageActivationRecovery(anchor, "retire", operationId);
        }
        await expect(readPackageActivationStatus(anchor, operationId)).resolves.toMatchObject({
          phase: "complete",
        });
      },
    );

    it("replaces only the completed one-slot receipt under new original-store admission", async () => {
      const first = await prepare();
      await runPackageActivationRecovery(first.anchor, "repair", first.operationId);
      await runPackageActivationRecovery(first.anchor, "retire", first.operationId);
      const before = openPackageActivationJournal(first.anchor).read();
      const second = await prepare();
      const after = openPackageActivationJournal(second.anchor).read();
      expect(after.descriptor.journalIdentity).toBe(before.descriptor.journalIdentity);
      expect(after.descriptor.operationId).not.toBe(before.descriptor.operationId);
      expect(after.revision).toBeGreaterThan(before.revision);
      expect(after.phase).toBe("prepared");
    });
  },
);
