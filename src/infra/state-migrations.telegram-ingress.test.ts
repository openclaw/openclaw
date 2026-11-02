import fsSync, { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createChannelIngressDrain } from "../channels/message/ingress-drain.js";
import { createChannelIngressQueue } from "../channels/message/ingress-queue.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginDoctorStateMigrationContext } from "./state-migrations.plugin-doctor-context.js";
import {
  expectFile as expectBytes,
  expectMissing,
  runPluginMigrations,
} from "./state-migrations.store.test-support.js";

type MigrationInput = Parameters<PluginDoctorStateMigration["detectLegacyState"]>[0];
const receivedAt = Date.now() - 60_000;

async function runDetectedMigrations(input: MigrationInput) {
  return (await runPluginMigrations("telegram", input)).map(({ result }) => result);
}

function expectSingleWarning(
  result: Awaited<ReturnType<typeof runDetectedMigrations>>[number] | undefined,
  warning: string,
  disposition?: "recoverable",
) {
  expect(result?.warnings).toEqual([expect.stringContaining(warning)]);
  expect(result?.warningDisposition).toBe(disposition);
}

function pending(updateId: number, text = "legacy update") {
  return {
    version: 1,
    updateId,
    receivedAt: receivedAt + updateId,
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

function spoolFixture(env: NodeJS.ProcessEnv, stateDir: string, accountId: string) {
  const spoolDir = path.join(stateDir, "telegram", `ingress-spool-${accountId}`);
  let input: MigrationInput | undefined;
  return {
    env,
    spoolDir,
    file: (name: string) => path.join(spoolDir, name),
    makeInput: (assertCurrent?: () => void) =>
      (input = migrationInput(env, stateDir, assertCurrent)),
    migrate: () => runDetectedMigrations((input ??= migrationInput(env, stateDir))),
    queue: <T>() =>
      createChannelIngressQueue<T>({
        channelId: "telegram",
        stateDir,
        ...(accountId === "default" ? {} : { accountId }),
      }),
  };
}
async function withSpool(
  run: (fixture: ReturnType<typeof spoolFixture>) => Promise<void>,
  accountId = "default",
) {
  await withOpenClawTestState(
    { label: "telegram-spool-import", applyEnv: false },
    async ({ env, stateDir }) => {
      const fixture = spoolFixture(env, stateDir, accountId);
      await fs.mkdir(fixture.spoolDir, { recursive: true });
      await run(fixture);
    },
  );
}

function migrationInput(env: NodeJS.ProcessEnv, stateDir: string, assertCurrent = () => {}) {
  const context = createPluginDoctorStateMigrationContext({
    pluginId: "telegram",
    env,
    config: {},
    channelIngress: { channelIds: ["telegram"], stateDir, mutation: { assertCurrent } },
  });
  return { config: {}, env, stateDir, oauthDir: path.join(stateDir, "credentials"), context };
}

describe("Telegram JSON spool Doctor import", () => {
  it.each(["stale", "fresh", "message-date", "edited-message", "missing-receipt"] as const)(
    "%s legacy update passes through migration before the drain can dispatch",
    (scenario) =>
      withSpool(async ({ file, migrate, queue: createQueue }) => {
        const shouldDispatch = ["fresh", "edited-message", "missing-receipt"].includes(scenario);
        const originalReceivedAt =
          scenario === "stale" ? receivedAt - 120 * 86_400_000 : receivedAt;
        const message = {
          ...pending(41).update.message,
          date: Math.floor(
            (scenario.includes("message-date") || scenario.includes("edited-message")
              ? receivedAt - 120 * 86_400_000
              : originalReceivedAt) / 1000,
          ),
        };
        const payload = {
          ...pending(41),
          receivedAt: originalReceivedAt,
          update: scenario.includes("edited-message")
            ? {
                update_id: 41,
                edited_message: { ...message, edit_date: Math.floor(receivedAt / 1000) },
              }
            : { update_id: 41, message },
        };
        const bytes = JSON.stringify(
          scenario === "missing-receipt" ? { ...payload, receivedAt: undefined } : payload,
        );
        const sourcePath = file("0000000000000041.json");
        await fs.writeFile(sourcePath, bytes);
        const oldestReceivedAt = originalReceivedAt - 86_400_000;
        if (scenario === "stale") {
          await fs.writeFile(
            file("0000000000000042.json"),
            JSON.stringify({
              ...pending(42),
              receivedAt: oldestReceivedAt,
            }),
          );
        }
        const results = await migrate();
        const queue = createQueue<typeof payload>();
        const handleUpdate = vi.fn();
        const drain = createChannelIngressDrain({
          queue,
          dispatchClaimedEvent: async (event, lifecycle) => {
            handleUpdate(event.payload.update);
            await lifecycle.onAdopted();
          },
        });
        try {
          await drain.drainOnce();
          await drain.waitForIdle();
          expect(handleUpdate).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
          if (!shouldDispatch) {
            expectSingleWarning(
              results[0],
              `${scenario === "stale" ? 2 : 1} stale legacy Telegram update`,
              "recoverable",
            );
            expect(results[0]?.warnings[0]).toContain(new Date(message.date * 1000).toISOString());
            const failed = await queue.listFailed?.();
            expect(failed).toHaveLength(scenario === "stale" ? 2 : 1);
            expect(failed).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  id: "0000000000000041",
                  reason: "stale-legacy-import",
                  receivedAt: originalReceivedAt,
                }),
              ]),
            );
            if (scenario === "stale") {
              expect(results[0]?.warnings[0]).toContain(new Date(oldestReceivedAt).toISOString());
              expect(results[0]?.changes).toEqual([]);
            }
            expect(await queue.resubmit?.("0000000000000041")).toMatchObject({
              kind: "unrecoverable",
            });
          } else {
            expect(handleUpdate).toHaveBeenCalledWith(payload.update);
            expect(results[0]?.warnings ?? []).toEqual([]);
          }
          await expectBytes(`${sourcePath}.migrated`, bytes);
          expect(await migrate()).toEqual([]);
        } finally {
          drain.dispose();
        }
      }),
  );

  it("backs up published spool bytes, replays pending claims in order, and retains failure tombstones", () =>
    withSpool(async ({ file, migrate, queue: createQueue }) => {
      // These are the v2026.5.28 writer's three committed file shapes.
      const fixtures = [
        ["0000000000000041.json", pending(41)],
        [
          "0000000000000042.json.processing",
          {
            ...pending(42),
            claim: { processId: "999999:old", processPid: 999999, claimedAt: receivedAt + 100 },
          },
        ],
        [
          "0000000000000043.json.failed",
          {
            version: 1,
            updateId: 43,
            receivedAt: receivedAt - 120 * 86_400_000,
            failure: {
              reason: "handler_timeout",
              message: "synthetic timeout",
              failedAt: receivedAt + 200,
            },
          },
        ],
        ["0000000000000043.json", { ...pending(43), receivedAt: receivedAt - 120 * 86_400_000 }],
      ] as const;
      const originals = new Map<string, string>();
      for (const [name, value] of fixtures) {
        const bytes = `${JSON.stringify(value, null, 2)}\n`;
        originals.set(name, bytes);
        await fs.writeFile(file(name), bytes);
      }
      const importStartedAt = Date.now();
      const results = await migrate();
      expect(results).toHaveLength(1);
      expect(results[0]?.warnings).toEqual([]);
      for (const [name, bytes] of originals) {
        await expectBytes(file(`${name}.migrated`), bytes);
        await expectMissing(file(name));
      }
      const queue = createQueue();
      // Fresh imported work remains eligible for replay within Telegram’s 24-hour window.
      expect(await queue.prune({ pendingTtlMs: 86_400_000, now: importStartedAt })).toBe(0);
      const beforeRetry = await queue.listPending({ orderBy: "id" });
      expect(beforeRetry.map((row) => row.payload)).toEqual([pending(41), pending(42)]);
      expect(beforeRetry.map((row) => row.receivedAt)).toEqual([receivedAt + 41, receivedAt + 42]);
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listFailed?.()).toEqual([
        expect.objectContaining({
          id: "0000000000000043",
          receivedAt: receivedAt - 120 * 86_400_000,
          failedAt: receivedAt + 200,
          reason: "handler_timeout",
          message: "synthetic timeout",
        }),
      ]);
      expect(await queue.resubmit?.("0000000000000043")).toMatchObject({ kind: "unrecoverable" });

      // Replay the archive-removal crash window: committed rows are not overwritten or duplicated.
      for (const [name, bytes] of originals) {
        await fs.writeFile(file(name), bytes);
      }
      expect((await migrate())[0]?.warnings).toEqual([]);
      expect(await queue.listPending({ orderBy: "id" })).toEqual(beforeRetry);
      expect(await migrate()).toEqual([]);
      const first = await queue.claimNext({ orderBy: "id" });
      expect(first?.id).toBe("0000000000000041");
      expect(await queue.complete(first!, { completedAt: receivedAt + 1_000 })).toBe(true);
      expect((await queue.claimNext({ orderBy: "id" }))?.id).toBe("0000000000000042");
      await queue.prune({ completedTtlMs: 1, failedTtlMs: 1, now: receivedAt + 1_002 });
      await fs.writeFile(file("0000000000000041.json"), originals.get("0000000000000041.json")!);
      // A pending twin remains suppressed even when its historical failure file was removed first.
      await fs.writeFile(file("0000000000000043.json"), originals.get("0000000000000043.json")!);
      const claim = file(
        "0000000000000041.json.doctor-importing-4242-12345678-1234-4234-8234-123456789abc",
      );
      const failedTwinClaim = file("0000000000000043.json.doctor-importing");
      await fs.rename(file("0000000000000041.json"), claim);
      await fs.rename(file("0000000000000043.json"), failedTwinClaim);
      expect((await migrate())[0]?.warnings).toEqual([]);
      await expectMissing(claim);
      await expectMissing(failedTwinClaim);
      expect(await queue.listPending()).toEqual([]);
      expect(await queue.listFailed?.()).toEqual([]);
      expect((await queue.listClaims()).map((row) => row.id)).toEqual(["0000000000000042"]);

      // A replaced source has a distinct content receipt; the original receipt remains permanent.
      await fs.writeFile(
        file("0000000000000041.json"),
        JSON.stringify(pending(41, "replacement bytes")),
      );
      expect((await migrate())[0]?.warnings).toEqual([]);
      expect((await queue.listPending()).map((row) => row.payload)).toEqual([
        pending(41, "replacement bytes"),
      ]);
      expect(await queue.delete("0000000000000041")).toBe(true);
      await fs.writeFile(file("0000000000000041.json"), originals.get("0000000000000041.json")!);
      expect((await migrate())[0]?.warnings).toEqual([]);
      expect(await queue.listPending()).toEqual([]);
    }));

  it("preserves conflicting or invalid sources and existing canonical work", () =>
    withSpool(async ({ file, migrate, queue: createQueue }) => {
      const source = file("0000000000000041.json");
      const bytes = `${JSON.stringify(pending(41))}\n`;
      await fs.writeFile(source, bytes);
      await fs.writeFile(file("0000000000000042.json"), "invalid JSON\n");
      const queue = createQueue();
      await queue.enqueue("0000000000000041", pending(41, "canonical"), {
        receivedAt: receivedAt + 41,
      });
      const original = await queue.listPending();
      const results = await migrate();
      expect(results[0]?.warnings).toHaveLength(2);
      expect(results[0]?.warningDisposition).toBeUndefined();
      expect(results[0]?.warnings[0]).toContain(
        "current SQLite ingress contains a different event",
      );
      expect(
        results[0]?.warnings.every((warning) => warning.includes("openclaw doctor --fix")),
      ).toBe(true);
      expect(await queue.listPending()).toEqual(original);
      await expectBytes(source, bytes);
      await expectBytes(`${source}.migrated`, bytes);
      expect(await fs.readFile(file("0000000000000042.json.migrated"), "utf8")).toBe(
        "invalid JSON\n",
      );
      // A conflict records no completed receipt: removing it still permits the legacy import.
      expect(await queue.delete("0000000000000041")).toBe(true);
      expect((await migrate())[0]?.warnings).toHaveLength(1);
      expect((await queue.listPending()).map((row) => row.payload)).toEqual([pending(41)]);
    }, "retired_account"));

  it.each(["source", "receipt", "expired-authority"] as const)(
    "classifies %s cleanup failures only after verifying the committed import and recovery bytes",
    (failure) =>
      withSpool(async ({ env, spoolDir, file, makeInput, migrate, queue: createQueue }) => {
        const source = file("0000000000000041.json");
        const bytes = `${JSON.stringify(pending(41))}\n`;
        await fs.writeFile(source, bytes);
        let active = true;
        const input = makeInput(() => {
          if (!active) {
            throw new Error("repair owner expired during cleanup");
          }
        });
        const access = input.context.channelIngressQueues?.[0];
        const importEntries = access?.importLegacyEntries;
        if (!access || !importEntries) {
          throw new Error("Expected Doctor ingress import access");
        }
        if (failure !== "source") {
          access.importLegacyEntries = (entries) => {
            const result = importEntries(entries);
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
          if (failure === "source" && String(filePath).startsWith(`${source}.doctor-importing-`)) {
            throw Object.assign(new Error("source cleanup denied"), { code: "EACCES" });
          }
          return unlink(filePath);
        });
        try {
          const results = await migrate();
          if (failure !== "expired-authority") {
            await expectBytes(source, bytes);
          } else {
            await expectMissing(source);
            const claims = (await fs.readdir(spoolDir)).filter((name) =>
              name.startsWith(`${path.basename(source)}.doctor-importing-`),
            );
            expect(claims).toHaveLength(1);
            await expectBytes(file(claims[0]!), bytes);
          }
          expectSingleWarning(
            results[0],
            failure === "expired-authority"
              ? "repair owner expired during cleanup"
              : `Retained Telegram spool source ${source}`,
            failure === "expired-authority" ? undefined : "recoverable",
          );
          await expectBytes(`${source}.migrated`, bytes);
          const queue = createQueue();
          const committed = await queue.listPending();
          expect(committed.map((row) => row.payload)).toEqual([pending(41)]);
          remove.mockRestore();
          if (failure !== "expired-authority") {
            access.importLegacyEntries = importEntries;
            if (failure === "receipt") {
              expect(await queue.delete("0000000000000041")).toBe(true);
            }
            expect((await migrate())[0]?.warnings).toEqual([]);
            expect(await queue.listPending()).toEqual(failure === "receipt" ? [] : committed);
            await expectMissing(source);
            expect(
              openOpenClawStateDatabase({ env })
                .db.prepare("SELECT removed_source FROM migration_sources WHERE source_path = ?")
                .get(source),
            ).toEqual({ removed_source: 1 });
          }
        } finally {
          remove.mockRestore();
        }
      }),
  );

  it.each(["authority", "backup"])(
    "retains originals after a %s failure and resumes safely",
    (failure) =>
      withSpool(async ({ env, file, makeInput, migrate, queue: createQueue }) => {
        const source = file("0000000000000043.json.failed");
        const bytes =
          '{"version":1,"updateId":43,"receivedAt":100,"failure":{"reason":"timeout","message":"original","failedAt":200}}\n';
        await fs.writeFile(source, bytes);
        const { db } = openOpenClawStateDatabase({ env });
        let transactionChecks = 0;
        let interrupt = true;
        makeInput(() => {
          if (interrupt && db.isTransaction && ++transactionChecks === 2) {
            if (failure === "authority") {
              throw new Error("repair owner expired before commit");
            }
            writeFileSync(`${source}.migrated`, "changed backup");
          }
        });
        const results = await migrate();
        expect(results[0]?.warningDisposition).toBeUndefined();
        expect(results[0]?.warnings).toContainEqual(
          expect.stringContaining(
            failure === "authority" ? "repair owner expired before commit" : "backup changed",
          ),
        );
        const queue = createQueue();
        expect(await queue.listPending()).toEqual([]);
        expect(await queue.listFailed?.()).toHaveLength(failure === "authority" ? 0 : 1);
        await expectBytes(source, bytes);
        expect(await fs.readFile(`${source}.migrated`, "utf8")).toBe(
          failure === "authority" ? bytes : "changed backup",
        );
        interrupt = false;
        expect((await migrate())[0]?.warnings).toEqual([]);
        expect(
          await fs.readFile(`${source}.migrated${failure === "backup" ? ".2" : ""}`, "utf8"),
        ).toBe(bytes);
        expect(await queue.resubmit?.("0000000000000043")).toMatchObject({
          kind: "unrecoverable",
          record: { failedAt: 200, receivedAt: 100, message: "original" },
        });
      }),
  );
});
