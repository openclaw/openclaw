// Transport regression: verifies that a stalled HTTP error body is cancelled
// before the guarded fetch release closes the dispatcher.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
  runCommandWithTimeout: vi.fn(),
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

vi.mock("../process/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  return {
    ...actual,
    runCommandWithTimeout: mocks.runCommandWithTimeout,
  };
});

const { runLinkUnderstanding } = await import("./runner.js");

beforeEach(() => {
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.runCommandWithTimeout.mockReset();
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
  it("cancels the error body before releasing the guard", async () => {
    const callOrder: string[] = [];

    // Create a real 500 response with unread body
    const failedResponse = new Response("server error", { status: 500 });

    // Spy on body.cancel to track call order
    const cancelSpy = vi.spyOn(failedResponse.body!, "cancel").mockImplementation(() => {
      callOrder.push("cancel");
      return Promise.resolve();
    });

    const release = vi.fn(async () => {
      callOrder.push("release");
    });

    // Mock fetchWithSsrFGuard to return the 500 response
    mocks.fetchWithSsrFGuard.mockResolvedValueOnce({
      response: failedResponse,
      finalUrl: "https://example.com/final",
      release,
    });

    // Mock runCommandWithTimeout to return success
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      killed: false,
      signal: null,
      stderr: "",
      stdout: "summary",
      termination: "exit",
    });

    const result = await runLinkUnderstanding({
      cfg: cfg(),
      ctx: ctx("see https://example.com/page"),
    });

    // The error body is not consumed by the CLI, so outputs should be empty.
    expect(result.outputs).toEqual([]);

    // Cancel should have been called before release.
    expect(callOrder).toEqual(["cancel", "release"]);

    // Cancel and release should have been called once.
    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
