import fsSync, { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import {
  coercePluginDoctorContractModule,
  type PluginDoctorContractModule,
  type PluginDoctorStateMigration,
} from "../plugins/doctor-contract-module.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];

async function runDetectedMigrations(input: MigrationInput) {
  const { stateMigrations } = coercePluginDoctorContractModule(
    await vi.importActual<PluginDoctorContractModule>(
      fileURLToPath(new URL("../../extensions/telegram/doctor-contract-api.ts", import.meta.url)),
    ),
  );
  const results = [];
  for (const migration of stateMigrations) {
    if (await migration.detectLegacyState(input)) {
      results.push(await migration.migrateLegacyState(input));
    }
  }
  return results;
}

function pending(updateId: number, text = "legacy update") {
  return {
    version: 1,
    updateId,
    receivedAt: 1_779_900_000_000 + updateId,
    update: {
      update_id: updateId,
      message: {
        message_id: updateId,
        chat: { id: 123, type: "private" },
        from: { id: 123, first_name: "Synthetic" },
        text,
      },
    },
  };
}

describe("Telegram JSON spool Doctor import", () => {
  it("backs up published spool bytes, replays pending claims in order, and retains failure tombstones", async () => {
    await withOpenClawTestState(
      { label: "telegram-spool-import", applyEnv: false },
      async ({ env, stateDir }) => {
        const spoolDir = path.join(stateDir, "telegram", "ingress-spool-default");
        await fs.mkdir(spoolDir, { recursive: true });
        // These are the v2026.5.28 writer's three committed file shapes.
        const fixtures = [
          ["0000000000000041.json", pending(41)],
          [
            "0000000000000042.json.processing",
            {
              ...pending(42),
              claim: { processId: "999999:old", processPid: 999999, claimedAt: 1_779_900_000_100 },
            },
          ],
          [
            "0000000000000043.json.failed",
            {
              version: 1,
              updateId: 43,
              receivedAt: 1_779_900_000_043,
              failure: {
                reason: "handler_timeout",
                message: "synthetic timeout",
                failedAt: 1_779_900_000_200,
              },
            },
          ],
          ["0000000000000043.json", pending(43)],
        ] as const;
        const originals = new Map<string, string>();
        for (const [name, value] of fixtures) {
          const bytes = `${JSON.stringify(value, null, 2)}\n`;
          originals.set(name, bytes);
          await fs.writeFile(path.join(spoolDir, name), bytes);
        }
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "telegram",
          env,
          config: {},
          channelIngress: {
            channelIds: ["telegram"],
            stateDir,
            mutation: { assertCurrent() {} },
          },
        });
        const input: MigrationInput = {
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context,
        };
        const importStartedAt = Date.now();
        const results = await runDetectedMigrations(input);
        // Baseline has no registered spool importer, so this fails at the real Doctor contract.
        expect(results).toHaveLength(1);
        expect(results[0]?.warnings).toEqual([]);
        for (const [name, bytes] of originals) {
          await expect(fs.readFile(path.join(spoolDir, `${name}.migrated`), "utf8")).resolves.toBe(
            bytes,
          );
          await expect(fs.stat(path.join(spoolDir, name))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
        const queue = createChannelIngressQueue({ channelId: "telegram", stateDir });
        // Historical receipt times must not make newly imported pending work expire before replay.
        expect(await queue.prune({ pendingTtlMs: 86_400_000, now: importStartedAt })).toBe(0);
        const beforeRetry = await queue.listPending({ orderBy: "id" });
        expect(beforeRetry.map((row) => row.payload)).toEqual([pending(41), pending(42)]);
        expect(beforeRetry.map((row) => row.receivedAt)).toEqual([
          1_779_900_000_041, 1_779_900_000_042,
        ]);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([
          expect.objectContaining({
            id: "0000000000000043",
            receivedAt: 1_779_900_000_043,
            failedAt: 1_779_900_000_200,
            reason: "handler_timeout",
            message: "synthetic timeout",
          }),
        ]);
        expect(await queue.resubmit?.("0000000000000043")).toMatchObject({ kind: "unrecoverable" });

        // Replay the archive-removal crash window: committed rows are not overwritten or duplicated.
        for (const [name, bytes] of originals) {
          await fs.writeFile(path.join(spoolDir, name), bytes);
        }
        expect((await runDetectedMigrations(input))[0]?.warnings).toEqual([]);
        expect(await queue.listPending({ orderBy: "id" })).toEqual(beforeRetry);
        expect(await runDetectedMigrations(input)).toEqual([]);
        const first = await queue.claimNext({ orderBy: "id" });
        expect(first?.id).toBe("0000000000000041");
        expect(await queue.complete(first!, { completedAt: 1_779_900_001_000 })).toBe(true);
        expect((await queue.claimNext({ orderBy: "id" }))?.id).toBe("0000000000000042");
        await queue.prune({ completedTtlMs: 1, failedTtlMs: 1, now: 1_779_900_001_002 });
        await fs.writeFile(
          path.join(spoolDir, "0000000000000041.json"),
          originals.get("0000000000000041.json")!,
        );
        // A pending twin remains suppressed even when its historical failure file was removed first.
        await fs.writeFile(
          path.join(spoolDir, "0000000000000043.json"),
          originals.get("0000000000000043.json")!,
        );
        const claim = path.join(
          spoolDir,
          "0000000000000041.json.doctor-importing-4242-12345678-1234-4234-8234-123456789abc",
        );
        const failedTwinClaim = path.join(spoolDir, "0000000000000043.json.doctor-importing");
        await fs.rename(path.join(spoolDir, "0000000000000041.json"), claim);
        await fs.rename(path.join(spoolDir, "0000000000000043.json"), failedTwinClaim);
        expect((await runDetectedMigrations(input))[0]?.warnings).toEqual([]);
        await expect(fs.stat(claim)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(failedTwinClaim)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toEqual([]);
        expect((await queue.listClaims()).map((row) => row.id)).toEqual(["0000000000000042"]);

        // A replaced source has a distinct content receipt; the original receipt remains permanent.
        await fs.writeFile(
          path.join(spoolDir, "0000000000000041.json"),
          JSON.stringify(pending(41, "replacement bytes")),
        );
        expect((await runDetectedMigrations(input))[0]?.warnings).toEqual([]);
        expect((await queue.listPending()).map((row) => row.payload)).toEqual([
          pending(41, "replacement bytes"),
        ]);
        expect(await queue.delete("0000000000000041")).toBe(true);
        await fs.writeFile(
          path.join(spoolDir, "0000000000000041.json"),
          originals.get("0000000000000041.json")!,
        );
        expect((await runDetectedMigrations(input))[0]?.warnings).toEqual([]);
        expect(await queue.listPending()).toEqual([]);
      },
    );
  });

  it("preserves conflicting or invalid sources and existing canonical work", async () => {
    await withOpenClawTestState(
      { label: "telegram-spool-conflict", applyEnv: false },
      async ({ env, stateDir }) => {
        const spoolDir = path.join(stateDir, "telegram", "ingress-spool-retired_account");
        await fs.mkdir(spoolDir, { recursive: true });
        const source = path.join(spoolDir, "0000000000000041.json");
        const bytes = `${JSON.stringify(pending(41))}\n`;
        await fs.writeFile(source, bytes);
        await fs.writeFile(path.join(spoolDir, "0000000000000042.json"), "invalid JSON\n");
        const queue = createChannelIngressQueue({
          channelId: "telegram",
          accountId: "retired_account",
          stateDir,
        });
        await queue.enqueue("0000000000000041", pending(41, "canonical"), {
          receivedAt: 1_779_900_000_041,
        });
        const original = await queue.listPending();
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "telegram",
          env,
          config: {},
          channelIngress: {
            channelIds: ["telegram"],
            stateDir,
            mutation: { assertCurrent() {} },
          },
        });
        const results = await runDetectedMigrations({
          config: {},
          env,
          stateDir,
          oauthDir: path.join(stateDir, "credentials"),
          context,
        });
        expect(results[0]?.warnings).toHaveLength(2);
        expect(results[0]?.warningDisposition).toBeUndefined();
        expect(results[0]?.warnings[0]).toContain(
          "canonical SQLite ingress contains a different event",
        );
        expect(
          results[0]?.warnings.every((warning) => warning.includes("openclaw doctor --fix")),
        ).toBe(true);
        expect(await queue.listPending()).toEqual(original);
        expect(await fs.readFile(source, "utf8")).toBe(bytes);
        expect(await fs.readFile(`${source}.migrated`, "utf8")).toBe(bytes);
        expect(
          await fs.readFile(path.join(spoolDir, "0000000000000042.json.migrated"), "utf8"),
        ).toBe("invalid JSON\n");
        // A conflict records no completed receipt: removing it still permits the legacy import.
        expect(await queue.delete("0000000000000041")).toBe(true);
        expect(
          (
            await runDetectedMigrations({
              config: {},
              env,
              stateDir,
              oauthDir: path.join(stateDir, "credentials"),
              context,
            })
          )[0]?.warnings,
        ).toHaveLength(1);
        expect((await queue.listPending()).map((row) => row.payload)).toEqual([pending(41)]);
      },
    );
  });

  it.each(["source", "receipt", "expired-authority"] as const)(
    "classifies %s cleanup failures only after verifying the committed import and recovery bytes",
    async (failure) => {
      await withOpenClawTestState(
        { label: "telegram-spool-cleanup", applyEnv: false },
        async ({ env, stateDir }) => {
          const spoolDir = path.join(stateDir, "telegram", "ingress-spool-default");
          await fs.mkdir(spoolDir, { recursive: true });
          const source = path.join(spoolDir, "0000000000000041.json");
          const bytes = `${JSON.stringify(pending(41))}\n`;
          await fs.writeFile(source, bytes);
          let active = true;
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "telegram",
            env,
            config: {},
            channelIngress: {
              channelIds: ["telegram"],
              stateDir,
              mutation: {
                assertCurrent() {
                  if (!active) {
                    throw new Error("repair owner expired during cleanup");
                  }
                },
              },
            },
          });
          const access = context.channelIngressQueues?.[0];
          const importEntries = access?.importLegacyEntries;
          if (!access || !importEntries) {
            throw new Error("Expected Doctor ingress import access");
          }
          if (failure !== "source") {
            access.importLegacyEntries = (input) => {
              const result = importEntries(input);
              return {
                ...result,
                markSourcesRemoved() {
                  active = failure !== "expired-authority";
                  throw new Error("receipt cleanup bookkeeping unavailable");
                },
              };
            };
          }
          const unlink = fsSync.unlinkSync;
          const remove = vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
            if (
              failure === "source" &&
              String(filePath).startsWith(`${source}.doctor-importing-`)
            ) {
              throw Object.assign(new Error("source cleanup denied"), { code: "EACCES" });
            }
            return unlink(filePath);
          });
          const input = {
            config: {},
            env,
            stateDir,
            oauthDir: path.join(stateDir, "credentials"),
            context,
          };
          try {
            const results = await runDetectedMigrations(input);
            if (failure !== "expired-authority") {
              await expect(fs.readFile(source, "utf8")).resolves.toBe(bytes);
            } else {
              await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
              const claims = (await fs.readdir(spoolDir)).filter((name) =>
                name.startsWith(`${path.basename(source)}.doctor-importing-`),
              );
              expect(claims).toHaveLength(1);
              expect(await fs.readFile(path.join(spoolDir, claims[0]!), "utf8")).toBe(bytes);
            }
            expect(results[0]?.warningDisposition).toBe(
              failure === "expired-authority" ? undefined : "recoverable",
            );
            expect(results[0]?.warnings).toHaveLength(1);
            expect(results[0]?.warnings[0]).toContain(
              failure === "expired-authority"
                ? "repair owner expired during cleanup"
                : `Retained Telegram spool source ${source}`,
            );
            expect(await fs.readFile(`${source}.migrated`, "utf8")).toBe(bytes);
            const queue = createChannelIngressQueue({ channelId: "telegram", stateDir });
            const committed = await queue.listPending();
            expect(committed.map((row) => row.payload)).toEqual([pending(41)]);
            remove.mockRestore();
            if (failure !== "expired-authority") {
              access.importLegacyEntries = importEntries;
              if (failure === "receipt") {
                expect(await queue.delete("0000000000000041")).toBe(true);
              }
              expect((await runDetectedMigrations(input))[0]?.warnings).toEqual([]);
              expect(await queue.listPending()).toEqual(failure === "receipt" ? [] : committed);
              await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
              expect(
                openOpenClawStateDatabase({ env })
                  .db.prepare("SELECT removed_source FROM migration_sources WHERE source_path = ?")
                  .get(source),
              ).toEqual({ removed_source: 1 });
            }
          } finally {
            remove.mockRestore();
          }
        },
      );
    },
  );

  it.each(["authority", "backup"])(
    "retains originals after a %s failure and resumes safely",
    async (failure) => {
      await withOpenClawTestState(
        { label: "telegram-spool-restart", applyEnv: false },
        async ({ env, stateDir }) => {
          const spoolDir = path.join(stateDir, "telegram", "ingress-spool-default");
          await fs.mkdir(spoolDir, { recursive: true });
          const source = path.join(spoolDir, "0000000000000043.json.failed");
          const bytes =
            '{"version":1,"updateId":43,"receivedAt":100,"failure":{"reason":"timeout","message":"original","failedAt":200}}\n';
          await fs.writeFile(source, bytes);
          const { db } = openOpenClawStateDatabase({ env });
          let transactionChecks = 0;
          let interrupt = true;
          const context = createPluginDoctorStateMigrationContext({
            pluginId: "telegram",
            env,
            config: {},
            channelIngress: {
              channelIds: ["telegram"],
              stateDir,
              mutation: {
                assertCurrent() {
                  if (interrupt && db.isTransaction && ++transactionChecks === 2) {
                    if (failure === "authority") {
                      throw new Error("repair owner expired before commit");
                    }
                    writeFileSync(`${source}.migrated`, "changed backup");
                  }
                },
              },
            },
          });
          const input = {
            config: {},
            env,
            stateDir,
            oauthDir: path.join(stateDir, "credentials"),
            context,
          };
          const results = await runDetectedMigrations(input);
          expect(results[0]?.warningDisposition).toBeUndefined();
          expect(results[0]?.warnings).toContainEqual(
            expect.stringContaining(
              failure === "authority" ? "repair owner expired before commit" : "backup changed",
            ),
          );
          const queue = createChannelIngressQueue({ channelId: "telegram", stateDir });
          expect(await queue.listPending()).toEqual([]);
          expect(await queue.listFailed?.()).toHaveLength(failure === "authority" ? 0 : 1);
          expect(await fs.readFile(source, "utf8")).toBe(bytes);
          expect(await fs.readFile(`${source}.migrated`, "utf8")).toBe(
            failure === "authority" ? bytes : "changed backup",
          );
          interrupt = false;
          expect((await runDetectedMigrations(input))[0]?.warnings).toEqual([]);
          expect(
            await fs.readFile(`${source}.migrated${failure === "backup" ? ".2" : ""}`, "utf8"),
          ).toBe(bytes);
          expect(await queue.resubmit?.("0000000000000043")).toMatchObject({
            kind: "unrecoverable",
            record: { failedAt: 200, receivedAt: 100, message: "original" },
          });
        },
      );
    },
  );
});
