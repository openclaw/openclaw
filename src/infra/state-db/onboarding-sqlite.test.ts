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

  // ── Edge cases ────────────────────────────────────────────────────────────

  it("getOnboardingState returns default when row is deleted", () => {
    // The migration seeds a row; delete it to test the fallback path
    db.prepare("DELETE FROM op1_onboarding WHERE id = 1").run();
    const state = getOnboardingState();
    expect(state.status).toBe("pending");
    expect(state.currentStep).toBe(1);
    expect(state.stepsCompleted).toEqual([]);
    expect(state.stepsSkipped).toEqual([]);
    expect(state.configSnapshot).toEqual({});
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeNull();
    expect(state.updatedAt).toBeNull();
  });

  it("upsertOnboardingState preserves existing fields when updating a subset", () => {
    upsertOnboardingState({
      status: "in_progress",
      currentStep: 3,
      stepsCompleted: [1, 2],
      stepsSkipped: [5],
      configSnapshot: { provider: "anthropic" },
    });

    // Update only currentStep; everything else should be preserved
    const state = upsertOnboardingState({ currentStep: 4 });
    expect(state.currentStep).toBe(4);
    expect(state.status).toBe("in_progress");
    expect(state.stepsCompleted).toEqual([1, 2]);
    expect(state.stepsSkipped).toEqual([5]);
    expect(state.configSnapshot).toEqual({ provider: "anthropic" });
  });

  it("markOnboardingComplete preserves startedAt", () => {
    const s1 = upsertOnboardingState({ status: "in_progress", currentStep: 2 });
    const startedAt = s1.startedAt;
    expect(startedAt).toBeTypeOf("number");

    const s2 = markOnboardingComplete();
    expect(s2.startedAt).toBe(startedAt);
    expect(s2.completedAt).toBeTypeOf("number");
    expect(s2.status).toBe("completed");
  });

  it("markOnboardingSkipped works from pending without startedAt", () => {
    const state = markOnboardingSkipped();
    expect(state.status).toBe("skipped");
    expect(state.startedAt).toBeNull();
    expect(state.completedAt).toBeTypeOf("number");
  });

  it("resetOnboardingState after complete clears completedAt", () => {
    upsertOnboardingState({ status: "in_progress", currentStep: 2 });
    markOnboardingComplete();

    const state = resetOnboardingState();
    expect(state.status).toBe("pending");
    expect(state.completedAt).toBeNull();
    expect(state.startedAt).toBeNull();
  });

  it("stripConfigSecrets handles empty object", () => {
    const stripped = stripConfigSecrets({});
    expect(stripped).toEqual({});
  });

  it("stripConfigSecrets preserves arrays and non-sensitive values", () => {
    const snapshot = {
      models: ["gpt-4", "claude-3"],
      count: 42,
      enabled: true,
      name: "my-config",
    };
    const stripped = stripConfigSecrets(snapshot);
    expect(stripped).toEqual(snapshot);
  });

  it("stripConfigSecrets masks multiple sensitive keys at different nesting levels", () => {
    const snapshot = {
      apiKey: "sk-1234567890",
      provider: {
        secretToken: "tok-abcdef",
        password: "hunter2!",
        nested: {
          credential: "cred-xyz123",
        },
      },
    };
    const stripped = stripConfigSecrets(snapshot);
    expect(stripped.apiKey).toContain("*");
    expect(stripped.apiKey).not.toBe("sk-1234567890");
    const provider = stripped.provider as Record<string, unknown>;
    expect(provider.secretToken).toContain("*");
    expect(provider.password).toContain("*");
    const nested = provider.nested as Record<string, unknown>;
    expect(nested.credential).toContain("*");
  });

  it("upsertOnboardingState with configSnapshot after row deletion creates new row", () => {
    db.prepare("DELETE FROM op1_onboarding WHERE id = 1").run();
    const state = upsertOnboardingState({
      status: "in_progress",
      configSnapshot: { model: "gpt-4" },
    });
    expect(state.status).toBe("in_progress");
    expect(state.configSnapshot).toEqual({ model: "gpt-4" });
    expect(state.startedAt).toBeTypeOf("number");
  });
});
