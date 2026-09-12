// Exercise timeout errors through the CLI RPC boundary and the shared output owner.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExpectedCliError,
  formatCliFailureLines,
  formatCliJsonFailure,
  isExpectedCliError,
} from "./failure-output.js";
import { callGatewayFromCliRuntime } from "./gateway-rpc.runtime.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

const { callGateway } = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../gateway/call.js", () => ({
  callGateway,
  isImplicitLocalGatewayTarget: vi.fn(),
}));
vi.mock("./progress.js", () => ({
  withProgress: async (_options: unknown, action: () => Promise<unknown>) => await action(),
}));

async function captureError(action: () => unknown): Promise<Error> {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the timeout validation to reject before dispatch.");
}

const timeoutHelp = "Invalid --timeout. Use a positive millisecond value, e.g. --timeout 30000.";
const outputOptions = { argv: [], env: {} };

beforeEach(() => {
  callGateway.mockReset();
  callGateway.mockResolvedValue({ ok: true });
});

describe("CLI timeout failure output", () => {
  it.each(["", " ", "bad", "0", "-1", "1.5", "1e3", "9007199254740992"])(
    "reports %j as an input error before Gateway dispatch",
    async (timeout) => {
      const error = await captureError(() => callGatewayFromCliRuntime("health", { timeout }));
      const value = timeout.trim();
      const message = value ? `${timeoutHelp} Received: "${value}".` : timeoutHelp;

      expect(error).toBeInstanceOf(ExpectedCliError);
      expect(isExpectedCliError(error)).toBe(true);
      expect(error.message).toBe(message);
      expect(formatCliFailureLines({ title: "CLI failed", error, ...outputOptions })).toEqual([
        message,
      ]);
      expect(formatCliJsonFailure(error, outputOptions)).toEqual({
        ok: false,
        error: { type: "cli_error", message },
      });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("keeps the one-document JSON failure for a JSON RPC caller", async () => {
    const error = await captureError(() =>
      callGatewayFromCliRuntime("health", { timeout: "bad", json: true }),
    );
    const message = `${timeoutHelp} Received: "bad".`;
    expect(JSON.stringify(formatCliJsonFailure(error, outputOptions))).toBe(
      JSON.stringify({ ok: false, error: { type: "cli_error", message } }),
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([undefined, null, " +25 "])("preserves valid RPC timeout %j", async (timeout) => {
    await expect(callGatewayFromCliRuntime("health", { timeout })).resolves.toEqual({ ok: true });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "health",
        timeoutMs: timeout === undefined ? 30_000 : timeout === null ? null : 25,
      }),
    );
  });

  it("preserves permissive fallback and strict invalid-type handling", async () => {
    expect(parseTimeoutMsWithFallback("", 5)).toBe(5);
    expect(parseTimeoutMsWithFallback({}, 5)).toBe(5);
    expect(parseTimeoutMsWithFallback(undefined, 5, { invalidType: "error" })).toBe(5);
    const error = await captureError(() =>
      parseTimeoutMsWithFallback({}, 5, { invalidType: "error" }),
    );
    expect(error).toBeInstanceOf(ExpectedCliError);
    expect(error.message).toBe(timeoutHelp);
  });

  it("does not reclassify unrelated Gateway errors as input errors", async () => {
    const error = new Error("unrelated transport failure");
    callGateway.mockRejectedValueOnce(error);
    await expect(callGatewayFromCliRuntime("health", { timeout: "25" })).rejects.toBe(error);
    expect(isExpectedCliError(error)).toBe(false);
    expect(formatCliFailureLines({ title: "CLI failed", error, ...outputOptions })).toContain(
      "[openclaw] Try: openclaw doctor",
    );
  });
});
