// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ModelAuthStatusResult } from "../types.ts";
import { loadModelAuthStatusState } from "./model-auth-status.ts";

function createState(results: ModelAuthStatusResult[]) {
  const request = vi.fn(async () => {
    const next = results.shift();
    if (!next) {
      throw new Error("unexpected request");
    }
    return next;
  });
  return {
    state: {
      client: { request },
      connected: true,
      modelAuthStatusLoading: false,
      modelAuthStatusResult: null,
      modelAuthStatusError: null,
    },
    request,
  };
}

describe("loadModelAuthStatusState", () => {
  it("retries once when OAuth provider usage loads without quota windows", async () => {
    const { state, request } = createState([
      {
        ts: 1,
        providers: [
          {
            provider: "openai-codex",
            displayName: "Codex",
            status: "ok",
            profiles: [{ profileId: "openai-codex:default", type: "oauth", status: "ok" }],
            usage: { windows: [] },
          },
        ],
      },
      {
        ts: 2,
        providers: [
          {
            provider: "openai-codex",
            displayName: "Codex",
            status: "ok",
            profiles: [{ profileId: "openai-codex:default", type: "oauth", status: "ok" }],
            usage: { windows: [{ label: "5h", usedPercent: 8 }] },
          },
        ],
      },
    ]);

    await loadModelAuthStatusState(state, { emptyUsageRetryDelayMs: 0 });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(["models.authStatus", {}]);
    expect(request.mock.calls[1]).toEqual(["models.authStatus", { refresh: true }]);
    expect(state.modelAuthStatusResult?.providers[0]?.usage?.windows).toEqual([
      { label: "5h", usedPercent: 8 },
    ]);
    expect(state.modelAuthStatusError).toBeNull();
  });

  it("does not retry api-key-only providers without quota windows", async () => {
    const { state, request } = createState([
      {
        ts: 1,
        providers: [
          {
            provider: "anthropic",
            displayName: "Anthropic",
            status: "static",
            profiles: [{ profileId: "anthropic:default", type: "api_key", status: "static" }],
            usage: { windows: [] },
          },
        ],
      },
    ]);

    await loadModelAuthStatusState(state, { emptyUsageRetryDelayMs: 0 });

    expect(request).toHaveBeenCalledTimes(1);
    expect(state.modelAuthStatusResult?.providers[0]?.provider).toBe("anthropic");
  });
});
