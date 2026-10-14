import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  deleteConfigMachineState,
  importConfigMachineState,
  writeConfigMachineState,
} from "../state/config-machine-state-write.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { shouldAttemptTtsPayload, shouldCleanTtsDirectiveText } from "./tts-config.js";
import { prepareTtsPreferences } from "./tts-preferences.js";
import { buildTtsSystemPromptHint } from "./tts-settings.js";
import { resolveTtsConfig, resolveTtsPrefsPath, resolveTtsPrefsPathAsync } from "./tts.js";

const tempDirs = useStateDatabaseTempDirs();

afterEach(() => {
  vi.restoreAllMocks();
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
  const cfg = { tts: { auto: "off" as const } };
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    // Deprecated synchronous calls never open SQLite to discover an unprepared path.
    expect(resolveTtsPrefsPath(resolveTtsConfig(cfg))).toBe(
      path.join(root, "settings", "tts.json"),
    );
    sql.expectIdle();
    const preparedTtsPreferences = await prepareTtsPreferences();
    expect(await prepareTtsPreferences()).toEqual(preparedTtsPreferences);
    expect(reads).toHaveBeenCalledTimes(1);
    const input = { cfg, preparedTtsPreferences };
    expect(shouldAttemptTtsPayload(input)).toBe(true);
    expect(shouldCleanTtsDirectiveText(input)).toBe(true);
    expect(resolveTtsPrefsPath(resolveTtsConfig(cfg), preparedTtsPreferences)).toBe(firstPath);
    expect(resolveTtsPrefsPath(resolveTtsConfig(cfg))).toBe(firstPath);
    expect(await resolveTtsPrefsPathAsync(resolveTtsConfig(cfg))).toBe(firstPath);
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
    expect(resolveTtsPrefsPath(resolveTtsConfig(cfg))).toBe(nextPath);
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
  const preparedTtsPreferences = await prepareTtsPreferences();
  expect(resolveTtsPrefsPath(resolveTtsConfig({}))).toBe(path.join(root, "settings", "tts.json"));
  expect(await resolveTtsPrefsPathAsync(resolveTtsConfig({}))).toBeTruthy();
  expect(shouldAttemptTtsPayload({ cfg: {}, preparedTtsPreferences })).toBe(false);
  expect(existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
});
