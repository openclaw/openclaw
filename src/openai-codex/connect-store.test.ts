import { describe, expect, it } from "vitest";
import {
  buildFailedBeforeCallbackRecord,
  OPENAI_CODEX_PENDING_TIMEOUT_MS,
  resolveOpenAICodexPendingLifecycle,
  type OpenAICodexPendingRecord,
} from "./connect-store.js";

function buildPending(overrides: Partial<OpenAICodexPendingRecord> = {}): OpenAICodexPendingRecord {
  return {
    version: 2,
    redirectUri: "https://app.mctl.ai/api/oidc-provider/openai-codex/callback",
    state: "state-1",
    codeVerifier: "verifier-1",
    startedAt: "2026-03-23T00:00:00.000Z",
    requestedBy: "tester",
    stage: "browser_flow_started",
    callbackReceivedAt: null,
    lastFailureAt: null,
    lastError: null,
    ...overrides,
  };
}

describe("openai-codex connect lifecycle", () => {
  it("marks stale browser auth as failed before callback", () => {
    const pending = buildPending();
    const now = Date.parse(pending.startedAt) + OPENAI_CODEX_PENDING_TIMEOUT_MS + 1;

    const lifecycle = resolveOpenAICodexPendingLifecycle(pending, now);

    expect(lifecycle.stage).toBe("failed_before_callback");
    expect(lifecycle.pending).toBe(false);
    expect(lifecycle.lastError).toContain("failed before the callback reached OpenClaw");
  });

  it("preserves callback-received as a distinct pending stage", () => {
    const pending = buildPending({
      stage: "callback_received",
      callbackReceivedAt: "2026-03-23T00:02:00.000Z",
    });

    const lifecycle = resolveOpenAICodexPendingLifecycle(pending, Date.parse(pending.startedAt));

    expect(lifecycle.stage).toBe("callback_received");
    expect(lifecycle.pending).toBe(true);
    expect(lifecycle.updatedAt).toBe("2026-03-23T00:02:00.000Z");
  });

  it("writes a durable failed-before-callback record", () => {
    const pending = buildPending();

    const next = buildFailedBeforeCallbackRecord(pending, Date.parse("2026-03-23T00:11:00.000Z"));

    expect(next.stage).toBe("failed_before_callback");
    expect(next.lastFailureAt).toBe("2026-03-23T00:11:00.000Z");
    expect(next.lastError).toContain("failed before the callback reached OpenClaw");
  });
});
