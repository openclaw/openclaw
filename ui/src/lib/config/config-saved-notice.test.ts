import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyConfigSnapshot } from "./config-draft-model.ts";
import { CONFIG_SAVED_NOTICE_MS, createConfigSavedNotice } from "./config-saved-notice.ts";
import { configSnapshot } from "./config-snapshot.test-support.ts";
import { createInitialConfigState, markConfigAwaitingApply } from "./config-state-model.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it("shows once per completed write and restarts for the next one", () => {
  const state = createInitialConfigState();
  const publish = vi.fn();
  const notice = createConfigSavedNotice(state, publish);

  notice.sync();
  expect(state.configSavedNotice).toBe(false);

  state.configSaveReceipts += 1;
  notice.sync();
  expect(state.configSavedNotice).toBe(true);

  vi.advanceTimersByTime(CONFIG_SAVED_NOTICE_MS - 1);
  state.configSaveReceipts += 1;
  notice.sync();
  vi.advanceTimersByTime(CONFIG_SAVED_NOTICE_MS - 1);
  expect(state.configSavedNotice).toBe(true);
  expect(publish).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(state.configSavedNotice).toBe(false);
  expect(publish).toHaveBeenCalledOnce();
});

it("does not publish after disposal", () => {
  const state = createInitialConfigState();
  const publish = vi.fn();
  const notice = createConfigSavedNotice(state, publish);
  state.configSaveReceipts += 1;
  notice.sync();
  notice.dispose();
  vi.advanceTimersByTime(CONFIG_SAVED_NOTICE_MS);
  expect(publish).not.toHaveBeenCalled();
});

const snapshot = (applied: string) => ({
  ...configSnapshot({}, "revision"),
  configRevisionHash: "revision",
  appliedConfigHash: applied,
});

it("holds the Apply prompt until a read after the grace period still reports it unapplied", () => {
  const state = createInitialConfigState();
  applyConfigSnapshot(state, snapshot("older"));
  expect(state).toMatchObject({ configNeedsApply: true, configApplyPromptHeld: false });

  markConfigAwaitingApply(state);
  expect(state).toMatchObject({ configNeedsApply: true, configApplyPromptHeld: true });

  // An immediate read races the Gateway's own apply and proves nothing.
  applyConfigSnapshot(state, snapshot("older"));
  expect(state.configApplyPromptHeld).toBe(true);

  vi.advanceTimersByTime(2_000);
  applyConfigSnapshot(state, snapshot("older"));
  expect(state.configApplyPromptHeld).toBe(false);
});

it("never prompts when the Gateway applies the write itself", () => {
  const state = createInitialConfigState();
  applyConfigSnapshot(state, snapshot("revision"));
  markConfigAwaitingApply(state);
  vi.advanceTimersByTime(5_000);
  applyConfigSnapshot(state, snapshot("revision"));
  expect(state.configNeedsApply).toBe(false);
});

it("prompts at once when the Gateway does not report applied revisions", () => {
  const state = createInitialConfigState();
  applyConfigSnapshot(state, configSnapshot({}, "revision"));
  markConfigAwaitingApply(state);
  expect(state).toMatchObject({ configNeedsApply: true, configApplyPromptHeld: false });
});
