// @vitest-environment node
import { runInNewContext } from "node:vm";
import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
} from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import { formatUiError, UserFacingError } from "./format-error.ts";

const PROGRAMMING_MESSAGE = "Cannot read properties of undefined (reading 'map')";

describe("formatUiError", () => {
  it.each([
    ["operator.read", "read access"],
    ["operator.write", "write access"],
    ["operator.admin", "admin access"],
    ["operator.future", "the required access"],
  ])("describes the required access without exposing the scope: %s", (scope, access) => {
    const error = new GatewayProtocolRequestError({
      code: "FORBIDDEN",
      message: "permission denied",
      details: { code: "MISSING_SCOPE", missingScope: scope, requiredScopes: [scope] },
    });
    expect(formatUiError(error)).toBe(
      `Couldn’t complete this request. Ask an admin to grant ${access}.`,
    );
  });

  it("keeps permission guidance when a denial only has the legacy message", () => {
    const error = new GatewayProtocolRequestError({
      code: "INVALID_REQUEST",
      message: "missing scope: operator.write",
    });

    expect(formatUiError(error)).toBe(
      "Couldn’t complete this request. Ask an admin to grant write access.",
    );
  });

  it("does not turn malformed permission details into access guidance", () => {
    const error = new GatewayProtocolRequestError({
      code: "FORBIDDEN",
      message: "permission denied",
      details: { code: "MISSING_SCOPE", missingScope: "operator.read", requiredScopes: [] },
    });

    expect(formatUiError(error)).toBe("permission denied");
  });

  it.each([
    ["Camera access is blocked.", "Camera access is blocked."],
    ["OPENAI_API_KEY=sk-1234567890abcdef", "OPENAI_API_KEY=sk-123...cdef"],
  ])("keeps an explicit UI message separate from its diagnostic cause: %s", (message, expected) => {
    const cause = new DOMException("denied", "NotAllowedError");
    const error = new UserFacingError(message, { cause });

    expect(error.cause).toBe(cause);
    expect(formatUiError(error)).toBe(expected);
  });

  it("formats structured causes through the browser-safe redactor", () => {
    const cause = Object.assign(new Error("OPENAI_API_KEY=sk-1234567890abcdef"), {
      code: "AUTH_FAILED",
    });

    expect(formatUiError(new Error("request failed", { cause }))).toBe(
      "request failed | OPENAI_API_KEY=sk-123...cdef | AUTH_FAILED",
    );
  });

  it("uses the fallback only when formatting produces an empty message", () => {
    expect(formatUiError("", "Request failed")).toBe("Request failed");
    expect(formatUiError("")).toBe("");
    expect(formatUiError(undefined, "Request failed")).toBe("undefined");
  });
});

describe("formatUiError programming errors", () => {
  const consoleError = vi.spyOn(console, "error");

  beforeEach(() => {
    consoleError.mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockReset();
  });

  const programmingErrors: Array<[string, Error]> = [
    ["TypeError", new TypeError(PROGRAMMING_MESSAGE)],
    ["ReferenceError", new ReferenceError("items is not defined")],
    ["RangeError", new RangeError("Invalid time value")],
    ["EvalError", new EvalError("eval is blocked")],
    ["URIError", new URIError("URI malformed")],
    ["InternalError", Object.assign(new Error("too much recursion"), { name: "InternalError" })],
    ["another realm's TypeError", runInNewContext("new TypeError('x is not a function')") as Error],
  ];

  it.each(programmingErrors)("shows the caller's fallback for %s", (_name, error) => {
    expect(formatUiError(error, "Logs could not load.")).toBe("Logs could not load.");
  });

  it.each(programmingErrors)(
    "shows the generic message without a fallback for %s",
    (_name, error) => {
      expect(formatUiError(error)).toBe("Request failed");
    },
  );

  it("keeps the original in the console, once per thrown value", () => {
    const error = new TypeError(PROGRAMMING_MESSAGE);

    formatUiError(error);
    formatUiError(error, "Logs could not load.");

    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.at(-1)).toBe(error);
  });

  it("drops a programming cause from a wrapper and keeps the rest", () => {
    const wrapped = new TypeError(PROGRAMMING_MESSAGE);
    const error = new AggregateError(
      [wrapped, Object.assign(new Error("disk full"), { code: "ENOSPC" })],
      "Could not add the template.",
    );

    expect(formatUiError(error)).toBe("Could not add the template. | disk full | ENOSPC");
    expect(consoleError.mock.calls[0]?.at(-1)).toBe(error);
  });

  it("keeps the message of a user-facing wrapper around a programming cause", () => {
    const error = new UserFacingError("Camera access is blocked.", {
      cause: new TypeError(PROGRAMMING_MESSAGE),
    });

    expect(formatUiError(error)).toBe("Camera access is blocked.");
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    ["Gateway request", new GatewayRequestError({ code: "UNAVAILABLE", message: "agent is busy" })],
    [
      "Gateway response quoting a server exception",
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: PROGRAMMING_MESSAGE }),
    ],
    [
      "Gateway timeout",
      new GatewayProtocolRequestTimeoutError({
        method: "logs.tail",
        timeoutMs: 1000,
        requestSent: true,
      }),
    ],
    ["plain Error", new Error(PROGRAMMING_MESSAGE)],
    ["DOMException", new DOMException("Permission denied", "NotAllowedError")],
    ["user-correctable JSON", new SyntaxError("Expected ',' or '}' in JSON at position 12")],
    ["Chromium fetch failure", new TypeError("Failed to fetch")],
    ["WebKit fetch failure", new TypeError("Load failed")],
    ["Firefox fetch failure", new TypeError("NetworkError when attempting to fetch resource.")],
    ["module load failure", new TypeError("Failed to fetch dynamically imported module: /a.js")],
    ["WebKit module load failure", new TypeError("Importing a module script failed.")],
  ])("passes %s through unchanged", (_name, error) => {
    expect(formatUiError(error, "Logs could not load.")).toBe(error.message);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not mistake a plain object for a thrown programming error", () => {
    const value = { name: "TypeError", message: "shaped like an error" };

    expect(formatUiError(value)).toBe(JSON.stringify(value));
  });
});
