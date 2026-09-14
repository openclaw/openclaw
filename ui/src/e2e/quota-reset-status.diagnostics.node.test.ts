import { describe, expect, it } from "vitest";
import { reportQuotaStatusFailure } from "./quota-reset-status.diagnostics.test-support.js";

function response(method: string, payload: unknown, ok = true) {
  return { action: "browser-rpc", method, frame: { type: "res", ok, payload } };
}

function readSummary(observations: unknown[], badge: unknown) {
  const lines: string[] = [];
  reportQuotaStatusFailure(observations, badge, (line) => lines.push(line));
  expect(lines).toHaveLength(1);
  const line = lines[0];
  if (line === undefined) {
    throw new Error("Missing quota diagnostic line");
  }
  return { line, summary: JSON.parse(line.replace("[quota-status-failure] ", "")) };
}

describe("quota readiness failure diagnostics", () => {
  it.each(["missing-auth", "auth-failed", "cooldown", undefined])(
    "retains the runtime unavailable reason %s without arbitrary text",
    (unavailableReason) => {
      const { summary } = readSummary(
        [
          response("models.list", {
            models: [{ provider: "openai", id: "gpt-5.5", available: false, unavailableReason }],
          }),
        ],
        "Signed in",
      );
      expect(summary.catalog.target).toEqual([
        { available: false, unavailableReason: unavailableReason ?? "absent" },
      ]);
    },
  );

  it("distinguishes a healthy account from an unavailable selected model", () => {
    const { summary } = readSummary(
      [
        response("models.list", {
          models: [{ provider: "openai", id: "gpt-5.5", available: false }],
          providerOutcomes: [{ provider: "openai", profileId: "openai:quota", status: "ready" }],
          pendingProviders: [],
        }),
        response("models.authStatus", {
          providers: [
            {
              provider: "openai",
              status: "ok",
              profiles: [{ profileId: "openai:quota", status: "ok" }],
            },
          ],
        }),
      ],
      "Signed in",
    );
    expect(summary).toMatchObject({
      badge: "Signed in",
      catalog: {
        observed: true,
        ok: true,
        modelCount: 1,
        openaiModelCount: 1,
        target: [{ available: false }],
        outcomes: [{ scope: "selected-profile", status: "ready" }],
        pendingOpenai: false,
      },
      auth: { observed: true, ok: true, providerStatus: "ok", profileStatus: "ok" },
    });
  });

  it("does not present an older successful response as a later RPC failure", () => {
    const { summary } = readSummary(
      [
        response("models.list", {
          models: [{ provider: "openai", id: "gpt-5.5", available: true }],
        }),
        response("models.list", undefined, false),
      ],
      undefined,
    );
    expect(summary.catalog).toMatchObject({
      observed: true,
      ok: false,
      modelCount: null,
      openaiModelCount: null,
      target: [],
    });
    expect(summary.auth).toMatchObject({ observed: false, ok: null });
    expect(summary.badge).toBe("unknown");
  });

  it("never emits tokens, arbitrary identifiers, URLs, messages, or credential fields", () => {
    const secret = "SYNTHETIC-PRIVATE-SENTINEL";
    const { line, summary } = readSummary(
      [
        response("models.list", {
          models: [
            { provider: "openai", id: "gpt-5.5", available: secret, unavailableReason: secret },
            { provider: secret, id: secret, name: secret },
          ],
          providerOutcomes: [
            { provider: "openai", profileId: secret, status: secret, message: secret },
          ],
          pendingProviders: [secret],
          token: secret,
        }),
        response("models.authStatus", {
          providers: [
            {
              provider: "openai",
              status: secret,
              email: secret,
              profiles: [{ profileId: "openai:quota", status: secret, token: secret }],
            },
          ],
        }),
        { action: "models-status", stdout: secret },
        { action: "browser-error", message: secret },
      ],
      secret,
    );
    expect(line).not.toContain(secret);
    expect(summary.catalog.target).toEqual([{ available: null, unavailableReason: "unknown" }]);
    expect(summary.catalog.outcomes).toEqual([{ scope: "other-profile", status: "unknown" }]);
    expect(summary.auth.profileStatus).toBe("unknown");
  });

  it("bounds duplicate rows and keeps malformed or missing observations explicit", () => {
    const { summary } = readSummary(
      [
        null,
        response("models.list", {
          models: Array.from({ length: 20 }, () => ({
            provider: "openai",
            id: "gpt-5.5",
            available: true,
          })),
          providerOutcomes: "not-an-array",
          pendingProviders: null,
        }),
      ],
      "Ready",
    );
    expect(summary.catalog.modelCount).toBe(20);
    expect(summary.catalog.target).toHaveLength(4);
    expect(summary.catalog.outcomes).toEqual([]);
    expect(summary.catalog.pendingOpenai).toBeNull();
  });

  it("cannot replace the original assertion error when the log writer fails", () => {
    const original = new Error("original readiness assertion");
    const logFailure = new Error("log failure");
    let caught: unknown;
    try {
      try {
        throw original;
      } catch (error) {
        reportQuotaStatusFailure([], undefined, () => {
          throw logFailure;
        });
        throw error;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
  });
});
