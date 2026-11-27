import { expect, it, vi } from "vitest";
import { loadCronStore, saveCronStore } from "../../../cron/store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { maybeRepairLegacyCronStore } from "./index.js";

const noteMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../packages/terminal-core/src/note.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../packages/terminal-core/src/note.js")>()),
  note: noteMock,
}));

it("backs up and pauses jobs when retired alert or delivery rules cannot be kept", async () => {
  await withOpenClawTestState({ label: "doctor-cron-alerts" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const jobs = [
      {
        id: "custom",
        failureAlert: { to: "ops", after: 3 },
        delivery: { mode: "announce", failureDestination: { to: "second" } },
      },
      { id: "best-effort", delivery: { mode: "announce", bestEffort: true } },
      { id: "off", failureAlert: false, delivery: { mode: "announce", bestEffort: false } },
      { id: "defaults", failureAlert: {} },
    ].map((job) =>
      Object.assign(
        {
          name: job.id,
          enabled: true,
          createdAtMs: 1000,
          updatedAtMs: 1000,
          schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "SQLite brief" },
          state: {},
        },
        job,
      ),
    );
    const confirm = vi.fn().mockResolvedValue(true);
    const repair = () =>
      maybeRepairLegacyCronStore({ cfg: {}, options: {}, prompter: { confirm } });

    await saveCronStore(storePath, { version: 1, jobs: jobs as never });
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
  });
});
