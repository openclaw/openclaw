import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing } from "../sessions/session-run-cancel.js";
import {
  onSessionRunCancel,
  requestSessionRunCancel,
  type SessionRunCancelTarget,
} from "./session-run-cancel-runtime.js";

const target: SessionRunCancelTarget = {
  kind: "session_run",
  sessionKey: "agent:main:main",
  runId: "run-1",
};

describe("plugin-sdk/session-run-cancel-runtime", () => {
  afterEach(() => {
    __testing.reset();
  });

  it("re-exports onSessionRunCancel registered against the same core store", () => {
    const handler = vi.fn();
    onSessionRunCancel(target, handler);
    expect(__testing.handlerCount(target)).toBe(1);
  });

  it("re-exports requestSessionRunCancel wired to the same core requester", async () => {
    const requester = vi.fn(async () => true);
    __testing.reset();
    const { setSessionRunAbortRequester } = await import("../sessions/session-run-cancel.js");
    setSessionRunAbortRequester(requester);

    const result = await requestSessionRunCancel(target, { source: "plugin:test" });

    expect(requester).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ requested: true, aborted: true });
  });
});
