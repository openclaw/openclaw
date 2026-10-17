import { describe, expect, it } from "vitest";
import { resolveControlUiReconnectResumeParams } from "./chat-server-timing.js";

describe("resolveControlUiReconnectResumeParams", () => {
  it("returns params unchanged when the internal field is absent", () => {
    const params = { message: "hi", sessionKey: "s1" };
    const result = resolveControlUiReconnectResumeParams(params);
    expect(result.params).toEqual(params);
    expect(result.resumeRequested).toBe(false);
  });

  it("returns params unchanged for non-object inputs", () => {
    for (const value of [null, undefined, "hello", 42, true, [1, 2, 3]]) {
      const result = resolveControlUiReconnectResumeParams(value);
      expect(result.resumeRequested).toBe(false);
    }
  });

  it("strips the field and marks resume when the value is true and the client is an operator UI client", () => {
    const params = {
      message: "hi",
      sessionKey: "s1",
      __controlUiReconnectResume: true,
    };
    const result = resolveControlUiReconnectResumeParams(params, {
      id: "operator-ui",
      mode: null,
    });
    expect(result.resumeRequested).toBe(true);
    expect(result.params).toEqual({ message: "hi", sessionKey: "s1" });
    expect("__controlUiReconnectResume" in (result.params as object)).toBe(false);
  });

  it("strips the field but does not mark resume when the value is true and the client is not an operator UI client", () => {
    // Regression: prior versions returned params unchanged when isOperatorUiClient returned
    // false, leaking __controlUiReconnectResume into the AJV-strict chat.send schema and
    // surfacing "invalid chat.send params: at root: unexpected property
    // '__controlUiReconnectResume'" to webchat clients on browser reconnect.
    const params = {
      message: "hi",
      sessionKey: "s1",
      __controlUiReconnectResume: true,
    };
    const result = resolveControlUiReconnectResumeParams(params, {
      id: "webchat",
      mode: null,
    });
    expect(result.resumeRequested).toBe(false);
    expect(result.params).toEqual({ message: "hi", sessionKey: "s1" });
    expect("__controlUiReconnectResume" in (result.params as object)).toBe(false);
  });

  it("strips the field when the value is true but clientInfo is missing", () => {
    const params = {
      message: "hi",
      sessionKey: "s1",
      __controlUiReconnectResume: true,
    };
    const result = resolveControlUiReconnectResumeParams(params);
    expect(result.resumeRequested).toBe(false);
    expect(result.params).toEqual({ message: "hi", sessionKey: "s1" });
  });

  it("strips the field when the value is not strictly true, even for operator UI clients", () => {
    for (const value of [false, 1, "true", null, {}]) {
      const params = {
        message: "hi",
        sessionKey: "s1",
        __controlUiReconnectResume: value,
      };
      const result = resolveControlUiReconnectResumeParams(params, {
        id: "operator-ui",
        mode: null,
      });
      expect(result.resumeRequested).toBe(false);
      expect(result.params).toEqual({ message: "hi", sessionKey: "s1" });
    }
  });

  it("does not mutate the input record", () => {
    const params = {
      message: "hi",
      sessionKey: "s1",
      __controlUiReconnectResume: true,
    };
    const snapshot = { ...params };
    resolveControlUiReconnectResumeParams(params, { id: "operator-ui", mode: null });
    expect(params).toEqual(snapshot);
  });
});
