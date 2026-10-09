import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
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
  writeConfigMachineState("tts.prefsPath", firstPath);
  setTtsMachinePrefsPathResolver(() => readConfigMachineState<string>("tts.prefsPath"));
  const cfg = { tts: { auto: "off" as const } };
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    const preparedTtsPreferences = await prepareTtsPreferences();
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
    expect(shouldAttemptTtsPayload({ cfg, preparedTtsPreferences: next })).toBe(false);
    expect(buildTtsSystemPromptHint(cfg, "main", { preparedTtsPreferences: next })).toBeUndefined();
    // File preferences remain live within the captured path.
    writeFileSync(firstPath, JSON.stringify({ tts: { auto: "off" } }));
    expect(shouldAttemptTtsPayload(input)).toBe(false);
    sql.expectIdle();
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
