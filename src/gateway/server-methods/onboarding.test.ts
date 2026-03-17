import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetOnboardingDbForTest,
  setOnboardingDbForTest,
} from "../../infra/state-db/onboarding-sqlite.js";
import { runMigrations } from "../../infra/state-db/schema.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";
import { ErrorCodes } from "../protocol/index.js";
import { onboardingHandlers } from "./onboarding.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

function createInvokeParams(method: string, params: Record<string, unknown> = {}) {
  const respond = vi.fn();
  return {
    respond,
    invoke: () =>
      onboardingHandlers[method]({
        params,
        respond: respond as never,
        context: {} as never,
        client: null,
        req: { type: "req", id: "req-1", method },
        isWebchatConnect: () => false,
      }),
  };
}

describe("onboarding handlers", () => {
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

  // ── onboarding.status ──────────────────────────────────────────────────────
  it("onboarding.status returns default pending state", () => {
    const { respond, invoke } = createInvokeParams("onboarding.status");
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.status).toBe("pending");
    expect(payload.currentStep).toBe(1);
    expect(payload.stepsCompleted).toEqual([]);
  });

  // ── onboarding.update ──────────────────────────────────────────────────────
  it("onboarding.update advances step and returns in_progress", () => {
    const { respond, invoke } = createInvokeParams("onboarding.update", {
      currentStep: 2,
      stepsCompleted: [1],
    });
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.status).toBe("in_progress");
    expect(payload.currentStep).toBe(2);
    expect(payload.stepsCompleted).toEqual([1]);
  });

  it("onboarding.update rejects invalid params", () => {
    const { respond, invoke } = createInvokeParams("onboarding.update", {
      currentStep: "not-a-number",
    });
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  // ── onboarding.complete ────────────────────────────────────────────────────
  it("onboarding.complete marks completed", () => {
    // First start onboarding
    void createInvokeParams("onboarding.update", { currentStep: 2 }).invoke();

    const { respond, invoke } = createInvokeParams("onboarding.complete");
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.status).toBe("completed");
    expect(payload.completedAt).toBeTypeOf("number");
  });

  // ── onboarding.skip ────────────────────────────────────────────────────────
  it("onboarding.skip marks skipped", () => {
    const { respond, invoke } = createInvokeParams("onboarding.skip");
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.status).toBe("skipped");
    expect(payload.completedAt).toBeTypeOf("number");
  });

  // ── onboarding.reset ──────────────────────────────────────────────────────
  it("onboarding.reset returns to pending", () => {
    // First advance
    void createInvokeParams("onboarding.update", { currentStep: 3 }).invoke();
    void createInvokeParams("onboarding.complete").invoke();

    const { respond, invoke } = createInvokeParams("onboarding.reset");
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.status).toBe("pending");
    expect(payload.currentStep).toBe(1);
  });

  // ── onboarding.validatePath ────────────────────────────────────────────────
  it("onboarding.validatePath validates an existing writable directory", () => {
    const { respond, invoke } = createInvokeParams("onboarding.validatePath", {
      path: "/tmp",
    });
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.exists).toBe(true);
    expect(payload.isDirectory).toBe(true);
    expect(payload.writable).toBe(true);
    expect(payload.valid).toBe(true);
  });

  it("onboarding.validatePath rejects missing path param", () => {
    const { respond, invoke } = createInvokeParams("onboarding.validatePath", {});
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(false);
    expect(call[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
  });

  it("onboarding.validatePath handles non-existent path with writable parent", () => {
    const { respond, invoke } = createInvokeParams("onboarding.validatePath", {
      path: "/tmp/onboarding-test-nonexistent-" + Date.now(),
    });
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    expect(payload.exists).toBe(false);
    expect(payload.writable).toBe(true);
    expect(payload.valid).toBe(true);
  });

  // ── onboarding.status strips secrets ───────────────────────────────────────
  it("onboarding.status strips sensitive config values", () => {
    createInvokeParams("onboarding.update", {
      configSnapshot: { apiKey: "sk-test123456" },
    }).invoke() as void;

    const { respond, invoke } = createInvokeParams("onboarding.status");
    void invoke();
    const call = respond.mock.calls[0] as RespondCall;
    expect(call[0]).toBe(true);
    const payload = call[1] as Record<string, unknown>;
    const snapshot = payload.configSnapshot as Record<string, unknown>;
    expect(snapshot.apiKey).not.toBe("sk-test123456");
    expect(snapshot.apiKey).toContain("*");
  });
});
