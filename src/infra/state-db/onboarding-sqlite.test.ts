import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import {
  getOnboardingState,
  markOnboardingComplete,
  markOnboardingSkipped,
  resetOnboardingDbForTest,
  resetOnboardingState,
  setOnboardingDbForTest,
  stripConfigSecrets,
  upsertOnboardingState,
} from "./onboarding-sqlite.js";
import { runMigrations } from "./schema.js";

describe("onboarding-sqlite", () => {
  let db: ReturnType<typeof requireNodeSqlite>["DatabaseSync"]["prototype"];

  beforeEach(() => {
    const { DatabaseSync } = requireNodeSqlite();
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    setOnboardingDbForTest(db);
  });

  afterEach(() => {
    resetOnboardingDbForTest();
    try {
      db.close();
    } catch {
      // ignore
    }
  });

  // ── Migration idempotency ──────────────────────────────────────────────────
  it("v17 migration runs idempotently", () => {
    expect(() => runMigrations(db)).not.toThrow();
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain("op1_onboarding");
  });

  // ── Default state ──────────────────────────────────────────────────────────
  it("getOnboardingState returns default pending state", () => {
    const state = getOnboardingState();
    expect(state.status).toBe("pending");
    expect(state.currentStep).toBe(1);
    expect(state.stepsCompleted).toEqual([]);
    expect(state.stepsSkipped).toEqual([]);
    expect(state.configSnapshot).toEqual({});
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
  });

  // ── Upsert ─────────────────────────────────────────────────────────────────
  it("upsertOnboardingState updates step and status", () => {
    const state = upsertOnboardingState({
      status: "in_progress",
      currentStep: 3,
      stepsCompleted: [1, 2],
      configSnapshot: { provider: "openai" },
    });
    expect(state.status).toBe("in_progress");
    expect(state.currentStep).toBe(3);
    expect(state.stepsCompleted).toEqual([1, 2]);
    expect(state.configSnapshot).toEqual({ provider: "openai" });
    expect(state.startedAt).toBeTypeOf("number");
  });

  it("upsertOnboardingState merges config snapshots", () => {
    upsertOnboardingState({ configSnapshot: { a: 1 } });
    const state = upsertOnboardingState({ configSnapshot: { b: 2 } });
    expect(state.configSnapshot).toEqual({ a: 1, b: 2 });
  });

  it("upsertOnboardingState only sets startedAt on first transition to in_progress", () => {
    const s1 = upsertOnboardingState({ status: "in_progress", currentStep: 2 });
    const firstStartedAt = s1.startedAt;
    expect(firstStartedAt).toBeTypeOf("number");

    const s2 = upsertOnboardingState({ status: "in_progress", currentStep: 3 });
    expect(s2.startedAt).toBe(firstStartedAt);
  });

  // ── Complete ───────────────────────────────────────────────────────────────
  it("markOnboardingComplete sets completed status", () => {
    upsertOnboardingState({ status: "in_progress", currentStep: 2 });
    const state = markOnboardingComplete();
    expect(state.status).toBe("completed");
    expect(state.completedAt).toBeTypeOf("number");
  });

  // ── Skip ───────────────────────────────────────────────────────────────────
  it("markOnboardingSkipped sets skipped status", () => {
    const state = markOnboardingSkipped();
    expect(state.status).toBe("skipped");
    expect(state.completedAt).toBeTypeOf("number");
  });

  // ── Reset ──────────────────────────────────────────────────────────────────
  it("resetOnboardingState resets to pending", () => {
    upsertOnboardingState({
      status: "in_progress",
      currentStep: 5,
      stepsCompleted: [1, 2, 3, 4],
      configSnapshot: { foo: "bar" },
    });
    const state = resetOnboardingState();
    expect(state.status).toBe("pending");
    expect(state.currentStep).toBe(1);
    expect(state.stepsCompleted).toEqual([]);
    expect(state.stepsSkipped).toEqual([]);
    expect(state.configSnapshot).toEqual({});
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
  });

  // ── stripConfigSecrets ─────────────────────────────────────────────────────
  it("stripConfigSecrets masks sensitive values", () => {
    const snapshot = {
      provider: "openai",
      apiKey: "sk-abcdef123456",
      nested: {
        secretToken: "tok-xyz789",
        label: "safe",
      },
      shortKey: "ab",
    };
    const stripped = stripConfigSecrets(snapshot);
    expect(stripped.provider).toBe("openai");
    // "sk-abcdef123456" = 15 chars → 2 prefix + 11 stars + 2 suffix
    expect(stripped.apiKey).toBe("sk***********56");
    // "tok-xyz789" = 10 chars → 2 prefix + 6 stars + 2 suffix
    expect((stripped.nested as Record<string, unknown>).secretToken).toBe("to******89");
    expect((stripped.nested as Record<string, unknown>).label).toBe("safe");
    expect(stripped.shortKey).toBe("****");
  });
});
