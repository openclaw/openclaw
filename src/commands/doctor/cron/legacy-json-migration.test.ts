import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import * as cronStore from "../../../cron/store.js";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import type { CronJob } from "../../../cron/types.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { repairLegacyCronStoreWithoutPrompt } from "./legacy-repair.js";

it("imports pre-July cron jobs and runtime state, preserves current jobs, and archives all history", async () => {
  await withOpenClawTestState({ label: "cron-pre-july" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const cfg = { cron: { store: storePath } } as OpenClawConfig;
    const current: CronJob = {
      id: "current",
      name: "Current definition",
      enabled: false,
      agentId: "main",
      createdAtMs: 1,
      updatedAtMs: 8,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "current" },
      state: { lastRunAtMs: 7 },
    };
    await saveCronStore(storePath, { version: 1, jobs: [current] });
    const retained = (await loadCronStore(storePath)).jobs[0];
    const legacy = {
      ...current,
      id: "legacy",
      name: "Legacy definition",
      enabled: true,
      state: {},
    };
    const originals = new Map([
      [
        storePath,
        JSON.stringify({
          version: 1,
          jobs: [
            { ...current, name: "Stale copy" },
            legacy,
            { ...legacy, id: undefined, name: "Idless" },
          ],
        }),
      ],
      [
        fixture.statePath("cron", "jobs-state.json"),
        JSON.stringify({
          version: 1,
          jobs: { legacy: { updatedAtMs: 12, state: { lastRunAtMs: 11, lastStatus: "ok" } } },
        }),
      ],
      [
        fixture.statePath("cron", "runs", "legacy.jsonl"),
        '{"ts":11,"jobId":"legacy","action":"finished","status":"ok"}\n',
      ],
      [fixture.statePath("cron", "runs", "other.jsonl"), "unparseable historical line\n"],
    ]);
    for (const [filePath, bytes] of originals) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, bytes);
    }
    const result = await repairLegacyCronStoreWithoutPrompt({ cfg });
    const jobs = (await loadCronStore(storePath)).jobs;
    expect(jobs).toHaveLength(3);
    expect(jobs.find((job) => job.id === "current")).toEqual(retained);
    expect(jobs.find((job) => job.id === "legacy")).toMatchObject({
      name: "Legacy definition",
      state: { lastRunAtMs: 11, lastStatus: "ok" },
      updatedAtMs: 12,
    });
    expect(jobs.find((job) => job.name === "Idless")?.id).toMatch(/^cron-migrated-2-/);
    for (const [filePath, bytes] of originals) {
      expect(await fs.readFile(`${filePath}.migrated`, "utf8")).toBe(bytes);
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.warnings.join("\n")).toContain(`${filePath}.migrated`);
    }
    expect(result.warnings.join("\n")).toContain("Historical runs remain readable");
    expect(await repairLegacyCronStoreWithoutPrompt({ cfg })).toEqual({
      changes: [],
      warnings: [],
    });
    expect((await loadCronStore(storePath)).jobs).toEqual(jobs);
    await fs.writeFile(storePath, originals.get(storePath)!);
    await repairLegacyCronStoreWithoutPrompt({ cfg });
    expect((await loadCronStore(storePath)).jobs).toEqual(jobs);
  });
});

it("archives uninterpretable cron definitions with actionable recovery instead of blocking Doctor", async () => {
  await withOpenClawTestState({ label: "cron-malformed-legacy" }, async (fixture) => {
    const storePath = await fixture.writeText("cron/jobs.json", "{truncated legacy definition");
    const result = await repairLegacyCronStoreWithoutPrompt({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
    });
    expect(await fs.readFile(`${storePath}.migrated`, "utf8")).toBe("{truncated legacy definition");
    expect(result.warnings.join("\n")).toContain(
      `Recover job definitions from ${storePath}.migrated`,
    );
    expect(result.warnings.join("\n")).toContain("openclaw automations add");
    expect((await loadCronStore(storePath)).jobs).toEqual([]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it.each(["load", "commit"])(
  "retains cron sources after a SQLite %s failure and archives only after retry",
  async (phase) => {
    await withOpenClawTestState({ label: "cron-import-retry" }, async (fixture) => {
      const storePath = await fixture.writeText(
        "cron/jobs.json",
        JSON.stringify({
          version: 1,
          jobs: [
            {
              id: "legacy",
              name: "Legacy",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "main",
              wakeMode: "now",
              payload: { kind: "systemEvent", text: "keep me" },
              state: {},
            },
          ],
        }),
      );
      const runtimePath = await fixture.writeText(
        "cron/jobs-state.json",
        JSON.stringify({
          version: 1,
          jobs: { legacy: { updatedAtMs: 12, state: { lastRunAtMs: 11 } } },
        }),
      );
      const originals = await Promise.all(
        [storePath, runtimePath].map(async (file) => [file, await fs.readFile(file)] as const),
      );
      const db = openOpenClawStateDatabase().db;
      const rejection =
        "CREATE TRIGGER reject_legacy_cron BEFORE INSERT ON cron_jobs BEGIN SELECT RAISE(ABORT, 'synthetic cron import failure'); END";
      const save = cronStore.saveCronJobsStore;
      const fault =
        phase === "commit"
          ? vi
              .spyOn(cronStore, "saveCronJobsStore")
              .mockImplementationOnce((target, store, options) =>
                save(target, store, {
                  ...options,
                  transactionHooks: {
                    ...options?.transactionHooks,
                    beforeWrite: (connection, schema) => {
                      options?.transactionHooks?.beforeWrite?.(connection, schema);
                      connection.exec(rejection);
                    },
                  },
                }),
              )
          : undefined;
      if (phase === "load") {
        db.exec(rejection);
      }
      const cfg = { cron: { store: storePath } } as OpenClawConfig;
      try {
        await expect(repairLegacyCronStoreWithoutPrompt({ cfg })).rejects.toThrow(
          phase === "load"
            ? "unexpected trigger reject_legacy_cron"
            : "synthetic cron import failure",
        );
        for (const [file, bytes] of originals) {
          expect(await fs.readFile(file)).toEqual(bytes);
        }
      } finally {
        fault?.mockRestore();
        if (phase === "load") {
          db.exec("DROP TRIGGER reject_legacy_cron");
        }
      }
      expect((await loadCronStore(storePath)).jobs).toEqual([]);
      await repairLegacyCronStoreWithoutPrompt({ cfg });
      expect((await loadCronStore(storePath)).jobs).toMatchObject([
        { id: "legacy", state: { lastRunAtMs: 11 } },
      ]);
      for (const [file, bytes] of originals) {
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await fs.readFile(`${file}.migrated`)).toEqual(bytes);
      }
    });
  },
);
