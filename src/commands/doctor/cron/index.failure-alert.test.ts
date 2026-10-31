import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { saveCronStore } from "../../../cron/store.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { maybeRepairLegacyCronStore } from "./index.js";

type StoredJob = Record<string, unknown>;
const WEBHOOK = "https://example.invalid/cron-finished";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

let tempRoot: string | null = null;
let storePath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  storePath = path.join(tempRoot, "cron", "jobs.json");
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  noteMock.mockClear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return { confirm: vi.fn().mockResolvedValue(confirmResult) };
}

function createCronConfig(webhook = WEBHOOK): OpenClawConfig {
  return { cron: { store: storePath, webhook } } as unknown as OpenClawConfig;
}

function repairCronStore(
  prompter: Parameters<typeof maybeRepairLegacyCronStore>[0]["prompter"] = makePrompter(true),
  cfg = createCronConfig(),
) {
  return maybeRepairLegacyCronStore({ cfg, options: {}, prompter });
}

function createCurrentCronJob(overrides: StoredJob = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "SQLite brief" },
    state: {},
    ...overrides,
  };
}

async function writeCurrentCronStore(jobs: StoredJob[]) {
  await saveCronStore(storePath, { version: 1, jobs: jobs as never });
}

function expectNoteContaining(message: string, title = "Cron"): void {
  expect(noteMock).toHaveBeenCalledWith(expect.stringContaining(message), title);
}

function expectNoNoteContaining(message: string, title = "Cron"): void {
  expect(noteMock).not.toHaveBeenCalledWith(expect.stringContaining(message), title);
}

describe("maybeRepairLegacyCronStore failure-alert delivery", () => {
  it("warns when a failure alert could not be delivered, with the recorded reason", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "alert-undeliverable",
        name: "Alert undeliverable",
        state: {
          lastRunStatus: "error",
          consecutiveErrors: 2,
          lastFailureNotificationDeliveryStatus: "not-delivered",
          lastFailureNotificationDeliveryError:
            "Channel is required (no configured channels detected)",
        },
      }),
    ]);
    const prompter = makePrompter(true);

    await repairCronStore(prompter);

    expectNoteContaining("1 automation has a failure alert that could not be delivered");
    expectNoteContaining("Alert undeliverable (alert-undeliverable)");
    expectNoteContaining("Channel is required (no configured channels detected)");
    expectNoteContaining("Configure a messaging channel for the gateway");
    expect(prompter.confirm).not.toHaveBeenCalled();
  });

  it("does not warn when the failure alert was delivered", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "alert-delivered",
        name: "Alert delivered",
        state: {
          lastRunStatus: "error",
          consecutiveErrors: 2,
          lastFailureNotificationDeliveryStatus: "delivered",
        },
      }),
    ]);

    await repairCronStore();

    expectNoNoteContaining("could not be delivered");
  });

  it("does not warn when no failure alert was requested or its delivery is unsettled", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "alert-not-requested",
        state: { lastFailureNotificationDeliveryStatus: "not-requested" },
      }),
      createCurrentCronJob({
        id: "alert-unknown",
        state: { lastFailureNotificationDeliveryStatus: "unknown" },
      }),
      createCurrentCronJob({ id: "alert-absent", state: {} }),
    ]);

    await repairCronStore();

    expectNoNoteContaining("could not be delivered");
  });
});
