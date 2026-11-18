import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { maybeRepairLegacyCronStore } from "./index.js";

const noteMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

it("backs up and pauses jobs when retired alert or delivery rules cannot be kept", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-alerts-"));
  const storePath = path.join(root, "cron", "jobs.json");
  const store = {
    version: 1 as const,
    jobs: [
      {
        id: "custom",
        failureAlert: { to: "ops", after: 3 },
        delivery: { mode: "announce", failureDestination: { to: "second" } },
      },
      { id: "best-effort", delivery: { mode: "announce", bestEffort: true } },
      { id: "off", failureAlert: false, delivery: { mode: "announce", bestEffort: false } },
      { id: "defaults", failureAlert: {} },
    ].map((job) => ({
      name: job.id,
      enabled: true,
      createdAtMs: 1000,
      updatedAtMs: 1000,
      schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "SQLite brief" },
      state: {},
      ...job,
    })),
  };
  const confirm = vi.fn().mockResolvedValue(true);
  const repair = () =>
    maybeRepairLegacyCronStore({
      cfg: { cron: { store: storePath } },
      options: {},
      prompter: { confirm },
    });
  try {
    await saveCronStore(storePath, { ...store, jobs: store.jobs as never });
    await repair();
    expect((await loadCronStore(storePath)).jobs).toMatchObject(
      expect.arrayContaining([
        expect.objectContaining({
          id: "custom",
          enabled: false,
          failureAlert: true,
          delivery: { mode: "announce" },
        }),
        expect.objectContaining({
          id: "best-effort",
          enabled: false,
          failureAlert: false,
          delivery: { mode: "announce" },
        }),
        expect.objectContaining({
          id: "off",
          enabled: true,
          failureAlert: false,
          delivery: { mode: "announce" },
        }),
        expect.objectContaining({ id: "defaults", enabled: true, failureAlert: true }),
      ]),
    );
    const notes = JSON.stringify(noteMock.mock.calls);
    expect(notes).toContain("Saved pre-repair cron backup");
    expect(notes).toContain("delivery.failureDestination.to");
    expect(notes).toContain("failureAlert.to");
    expect(notes).toContain("Paused because");
    confirm.mockClear();
    await repair();
    expect(confirm).not.toHaveBeenCalled();
  } finally {
    await closeOpenClawStateDatabaseAsync();
    await fs.rm(root, { recursive: true, force: true });
  }
});
