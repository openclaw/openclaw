import fs, { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ttsHandlers } from "../gateway/server-methods/tts.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { withPluginRuntimePluginScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
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
import { updateTtsPrefsAsync } from "./tts-settings-write-worker.js";
import { setTtsMaxLength } from "./tts-settings-writes.js";
import { buildTtsSystemPromptHint, buildTtsSystemPromptHintAsync } from "./tts-settings.js";
import { resolveTtsConfig, resolveTtsPrefsPath, resolveTtsPrefsPathAsync } from "./tts.js";

const tempDirs = useStateDatabaseTempDirs();
let root: string;
beforeEach(() => {
  root = tempDirs.make("openclaw-tts-prepared-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_TTS_PREFS", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("persists TTS RPC changes without main-thread flushes and preserves queued settings", async () => {
  const prefsPath = path.join(root, "settings", "tts.json");
  vi.stubEnv("OPENCLAW_TTS_PREFS", prefsPath);
  const flush = vi.spyOn(fs, "fsyncSync");
  const respond = vi.fn();
  await expectDefined(
    ttsHandlers["tts.enable"],
    "enable TTS",
  )({
    params: {},
    respond,
    context: { getRuntimeConfig: () => ({}) },
  } as never);
  expect(respond).toHaveBeenCalledWith(true, { enabled: true });
  expect(JSON.parse(fs.readFileSync(prefsPath, "utf8"))).toEqual({ tts: { auto: "always" } });
  await Promise.all([
    updateTtsPrefsAsync(prefsPath, { maxLength: 2000 }),
    updateTtsPrefsAsync(prefsPath, { summarize: false }),
    updateTtsPrefsAsync(prefsPath, { persona: " Reader " }),
    updateTtsPrefsAsync(prefsPath, { auto: "off" }),
  ]);
  expect(JSON.parse(fs.readFileSync(prefsPath, "utf8"))).toEqual({
    tts: { auto: "off", maxLength: 2000, summarize: false, persona: "reader" },
  });
  expect(flush).not.toHaveBeenCalled();
  if (process.platform !== "win32") {
    expect(fs.statSync(prefsPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(prefsPath)).mode & 0o777).toBe(0o700);
  }
  fs.writeFileSync(prefsPath, '{"tts":');
  await expect(updateTtsPrefsAsync(prefsPath, { maxLength: 3000 })).rejects.toThrow(
    "Repair the file or its permissions",
  );
  expect(fs.readFileSync(prefsPath, "utf8")).toBe('{"tts":');
});

it("orders synchronous SDK setters after already accepted asynchronous preferences", async () => {
  const prefsPath = path.join(root, "settings", "tts.json");
  const first = updateTtsPrefsAsync(prefsPath, { summarize: false });
  const second = updateTtsPrefsAsync(prefsPath, { maxLength: 2000 });
  setTtsMaxLength(prefsPath, 3000);
  const immediatelyPersisted = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  await Promise.all([first, second]);
  const expected = { tts: { summarize: false, maxLength: 3000 } };
  expect(immediatelyPersisted).toEqual(expected);
  expect(JSON.parse(fs.readFileSync(prefsPath, "utf8"))).toEqual(expected);

  fs.writeFileSync(prefsPath, '{"tts":');
  const failed = updateTtsPrefsAsync(prefsPath, { maxLength: 2000 });
  expect(() => setTtsMaxLength(prefsPath, 3000)).toThrow("Repair the file or its permissions");
  await expect(failed).rejects.toThrow("Repair the file or its permissions");
  expect(fs.readFileSync(prefsPath, "utf8")).toBe('{"tts":');
});

it("drains accepted preferences before closing the worker owner and accepts writes after restart", async () => {
  const prefsPath = path.join(root, "settings", "tts.json");
  const first = updateTtsPrefsAsync(prefsPath, { summarize: false });
  const second = updateTtsPrefsAsync(prefsPath, { maxLength: 2000 });
  await Promise.all([first, second, closeDefaultRetainedNativeWorkerSource()]);
  expect(JSON.parse(fs.readFileSync(prefsPath, "utf8"))).toEqual({
    tts: { summarize: false, maxLength: 2000 },
  });
  await updateTtsPrefsAsync(prefsPath, { maxLength: 3000 });
  expect(JSON.parse(fs.readFileSync(prefsPath, "utf8"))).toEqual({
    tts: { summarize: false, maxLength: 3000 },
  });
});

it("carries the worker-read path through delivery and plugin prompt rendering without caller SQL", async () => {
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
  const config = resolveTtsConfig(cfg);
  const buildHint = expectDefined(
    createPluginRuntime().tts.buildSystemPromptHintAsync,
    "current host TTS prompt-hint API",
  );
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const sql = observeMainThreadSql();
  sql.calibrate();
  try {
    // Deprecated synchronous calls never open SQLite to discover an unprepared path.
    expect(resolveTtsPrefsPath(config)).toBe(path.join(root, "settings", "tts.json"));
    sql.expectIdle();
    const hint = await buildHint(cfg, "main", { messageToolOnly: true });
    expect(hint).toContain("Use message(action=send) with voiceText");
    expect(hint).toContain("voiceProvider/voiceId");
    expect(hint).not.toContain("[[tts:");
    const preparedTtsPreferences = await prepareTtsPreferences();
    expect(await prepareTtsPreferences()).toEqual(preparedTtsPreferences);
    expect(reads).toHaveBeenCalledTimes(1);
    const input = { cfg, preparedTtsPreferences };
    expect(shouldAttemptTtsPayload(input)).toBe(true);
    expect(shouldCleanTtsDirectiveText(input)).toBe(true);
    expect([
      resolveTtsPrefsPath(config, preparedTtsPreferences),
      resolveTtsPrefsPath(config),
      await resolveTtsPrefsPathAsync(config),
    ]).toEqual([firstPath, firstPath, firstPath]);
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
    expect(resolveTtsPrefsPath(config)).toBe(nextPath);
    expect(shouldAttemptTtsPayload(input)).toBe(true);
    const next = await prepareTtsPreferences();
    expect(await buildHint(cfg, "main")).toBeUndefined();
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
  const preparedTtsPreferences = await prepareTtsPreferences();
  expect(await buildTtsSystemPromptHintAsync({})).toBeUndefined();
  expect(resolveTtsPrefsPath(resolveTtsConfig({}))).toBe(path.join(root, "settings", "tts.json"));
  expect(await resolveTtsPrefsPathAsync(resolveTtsConfig({}))).toBeTruthy();
  expect(shouldAttemptTtsPayload({ cfg: {}, preparedTtsPreferences })).toBe(false);
  expect(existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
});

it("keeps legacy hints synchronous and warns once per method while explicit awaited hints skip machine state", async () => {
  const prefsPath = path.join(root, "prefs.json");
  writeFileSync(prefsPath, JSON.stringify({ tts: { auto: "always", maxLength: 123 } }));
  vi.stubEnv("OPENCLAW_TTS_PREFS", prefsPath);
  const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  await withPluginRuntimePluginScope({ pluginId: "tts-hint-compat-consumer" }, async () => {
    expect(await buildTtsSystemPromptHintAsync({})).toContain("Keep spoken text ≤123 chars");
    expect(warning).not.toHaveBeenCalled();
    expect(buildTtsSystemPromptHint({})).toContain("Keep spoken text ≤123 chars");
    expect(buildTtsSystemPromptHint({})).toContain("Keep spoken text ≤123 chars");
  });
  expect(warning.mock.calls).toEqual(
    [
      "buildTtsSystemPromptHint is deprecated; use api.runtime.tts.buildSystemPromptHintAsync",
      "resolveTtsPrefsPath is deprecated; use resolveTtsPrefsPathAsync",
    ].map((message) => [
      expect.stringContaining(message),
      { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
    ]),
  );
  expect(existsSync(path.join(root, "state", "openclaw.sqlite"))).toBe(false);
  expect(reads).not.toHaveBeenCalled();
});
