import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import {
  deleteConfigMachineState,
  importConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { shouldAttemptTtsPayload, shouldCleanTtsDirectiveText } from "./tts-config.js";
import { prepareTtsPreferences } from "./tts-preferences.js";
import {
  buildTtsSystemPromptHint,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  setTtsMachinePrefsPathResolver,
} from "./tts-settings.js";

const tempDirs = useStateDatabaseTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
  setTtsMachinePrefsPathResolver();
  vi.unstubAllEnvs();
});

it("carries the worker-read path through delivery and prompt rendering without caller SQL", async () => {
  const root = tempDirs.make("openclaw-tts-prepared-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_TTS_PREFS", "");
  const firstPath = path.join(root, "first.json");
  const nextPath = path.join(root, "next.json");
  writeFileSync(firstPath, JSON.stringify({ tts: { auto: "always", maxLength: 321 } }));
  writeFileSync(nextPath, JSON.stringify({ tts: { auto: "off" } }));
  // Seed persisted startup state before any path admission has been published.
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
      "tts.prefsPath",
      JSON.stringify(firstPath),
      Date.now(),
    );
  });
  setTtsMachinePrefsPathResolver(() => readConfigMachineState<string>("tts.prefsPath"));
  const cfg = { tts: { auto: "off" as const } };
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    const preparedTtsPreferences = await prepareTtsPreferences();
    expect(await prepareTtsPreferences()).toEqual(preparedTtsPreferences);
    expect(reads).toHaveBeenCalledTimes(1);
    const input = { cfg, preparedTtsPreferences };
    expect(shouldAttemptTtsPayload(input)).toBe(true);
    expect(shouldCleanTtsDirectiveText(input)).toBe(true);
    expect(resolveTtsPrefsPath(resolveTtsConfig(cfg), preparedTtsPreferences)).toBe(firstPath);
    expect(buildTtsSystemPromptHint(cfg, "main", { preparedTtsPreferences })).toContain(
      "Keep spoken text ≤321 chars",
    );
    vi.stubEnv("OPENCLAW_TTS_PREFS", nextPath);
    expect(shouldAttemptTtsPayload(input)).toBe(false);
    vi.stubEnv("OPENCLAW_TTS_PREFS", "");
    sql.expectIdle();

    // A later turn observes the writer; callbacks of this turn retain its selected path.
    writeConfigMachineState("tts.prefsPath", nextPath);
    sql.clear();
    expect(shouldAttemptTtsPayload(input)).toBe(true);
    const next = await prepareTtsPreferences();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(shouldAttemptTtsPayload({ cfg, preparedTtsPreferences: next })).toBe(false);
    expect(buildTtsSystemPromptHint(cfg, "main", { preparedTtsPreferences: next })).toBeUndefined();
    // File preferences remain live within the captured path.
    writeFileSync(firstPath, JSON.stringify({ tts: { auto: "off" } }));
    expect(shouldAttemptTtsPayload(input)).toBe(false);
    sql.expectIdle();

    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        writeConfigMachineState("tts.prefsPath", firstPath);
        throw new Error("roll back preference change");
      }),
    ).toThrow("roll back preference change");
    // Rollback retires staged coverage; one owner read restores the committed path.
    expect(await prepareTtsPreferences()).toEqual(next);
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await prepareTtsPreferences()).toEqual(next);
    expect(reads).toHaveBeenCalledTimes(2);
    deleteConfigMachineState("tts.prefsPath");
    expect(await prepareTtsPreferences()).toEqual({ machinePrefsPath: undefined });
    importConfigMachineState([["tts.prefsPath", firstPath]]);
    expect(await prepareTtsPreferences()).toEqual(preparedTtsPreferences);
    expect(reads).toHaveBeenCalledTimes(2);
  } finally {
    sql.restore();
  }
});

it("carries missing machine state without creating a store or falling back to a sync read", async () => {
  const root = tempDirs.make("openclaw-tts-prepared-absent-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_TTS_PREFS", "");
  setTtsMachinePrefsPathResolver(() => {
    throw new Error("prepared absence must not invoke the synchronous SDK resolver");
  });
  const preparedTtsPreferences = await prepareTtsPreferences();
  expect(resolveTtsPrefsPath(resolveTtsConfig({}), preparedTtsPreferences)).toBeTruthy();
  expect(shouldAttemptTtsPayload({ cfg: {}, preparedTtsPreferences })).toBe(false);
  expect(existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
});

it("shares concurrent cold reads and refuses their result after the database owner retires", async () => {
  const root = tempDirs.make("openclaw-tts-retired-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
      "tts.prefsPath",
      JSON.stringify("retired.json"),
      Date.now(),
    );
  });
  const completed = createDeferred();
  const release = createDeferred();
  const execute = stateReads.executeExistingOpenClawStateRead;
  const reads = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockImplementationOnce(async (...args) => {
      const reply = await execute(...args);
      completed.resolve();
      await release.promise;
      return reply;
    });
  const first = prepareTtsPreferences();
  const second = prepareTtsPreferences();
  const pending = Promise.allSettled([first, second]);
  const refused = Promise.all([
    expect(first).rejects.toThrow(/admission|closed|retired/iu),
    expect(second).rejects.toThrow(/admission|closed|retired/iu),
  ]);
  try {
    await awaitGateBeforeSettlement(completed.promise, pending, "TTS path read did not finish");
    expect(reads).toHaveBeenCalledTimes(1);
    await closeOpenClawStateDatabaseAsync();
  } finally {
    release.resolve();
  }
  await refused;
  writeConfigMachineState("tts.prefsPath", "current.json");
  expect(await prepareTtsPreferences()).toEqual({ machinePrefsPath: "current.json" });
});
