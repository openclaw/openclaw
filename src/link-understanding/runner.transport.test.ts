// Transport regression: verifies that a stalled HTTP error body is cancelled
// before the guarded fetch release closes the dispatcher.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
  };
});

const { runLinkUnderstanding } = await import("./runner.js");

beforeEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
});

function cfg() {
  return {
    tools: {
      links: {
        enabled: true,
        models: [{ type: "cli", command: "summarize" }],
      },
    },
  } as OpenClawConfig;
}

function ctx(body: string): MsgContext {
  return { Body: body } as MsgContext;
}

describe("link understanding guarded fetch transport", () => {
  it("cancels an error response body before releasing the guard", async () => {
    const cancelSpy = vi.fn();
    const release = vi.fn(async () => {});
    
    // Create a real 500 response with unread body
    const failedResponse = new Response("server error", { status: 500 });
    
    // Spy on body.cancel
    if (failedResponse.body) {
      const originalCancel = failedResponse.body.cancel.bind(failedResponse.body);
      failedResponse.body.cancel = (...args: unknown[]) => {
        cancelSpy();
        return originalCancel(...args);
      };
    }
    
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: failedResponse,
      finalUrl: "https://example.com/final",
      release,
    });

    const result = await runLinkUnderstanding({
      cfg: cfg(),
      ctx: ctx("see https://example.com/page"),
    });

    // The error body is not consumed by the CLI, so outputs should be empty.
    expect(result.outputs).toEqual([]);

    // Cancel should have been called (fire-and-forget).
    expect(cancelSpy).toHaveBeenCalledOnce();
    
    // Release should have been called.
    expect(release).toHaveBeenCalledOnce();
  });
});
