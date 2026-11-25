import { describe, expect, it, vi } from "vitest";
import { executeProviderOperationWithRetry } from "./operation-retry.js";

describe("executeProviderOperationWithRetry", () => {
  const retry = { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
  const defaults = { provider: "test", stage: "read" as const, retry };
  const connectionError = (code: string) => Object.assign(new Error("connect failed"), { code });
  const rejecting = (error: Error) => vi.fn<() => Promise<never>>().mockRejectedValue(error);
  const run = (
    operation: () => Promise<unknown>,
    overrides: Partial<Parameters<typeof executeProviderOperationWithRetry>[0]> = {},
  ) => executeProviderOperationWithRetry({ ...defaults, operation, ...overrides });

  it("does not turn fractional attempts into an extra execution", async () => {
    const error = Object.assign(new Error("HTTP 503"), { status: 503 });
    const operation = rejecting(error);
    await expect(run(operation, { retry: { ...retry, attempts: 1.5 } })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["direct EPIPE", connectionError("EPIPE")],
    [
      "nested UND_ERR_SOCKET",
      new Error("fetch failed", { cause: connectionError("UND_ERR_SOCKET") }),
    ],
    ["nested ENOTFOUND", new Error("fetch failed", { cause: connectionError("ENOTFOUND") })],
    [429, Object.assign(new Error("Too Many Requests"), { status: 429 })],
    ["HTTP 429", new Error("HTTP 429 Too Many Requests")],
  ])("recovers from %s with one retry", async (_label, error) => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");
    await expect(run(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["HTTP 400", Object.assign(new Error("Bad Request"), { status: 400 })],
    ["ENOENT", new Error("ENOENT: no such file or directory")],
  ])("does not retry %s failures", async (_label, error) => {
    const operation = rejecting(error);
    await expect(run(operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(["caller", "retry-policy"])("preserves %s cancellation", async (source) => {
    const controller = new AbortController();
    const reason = new Error(`${source} cancelled provider read`);
    const operation = vi.fn(async () => {
      controller.abort(reason);
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });
    await expect(
      run(operation, {
        signal: source === "caller" ? controller.signal : undefined,
        retry: source === "caller" ? retry : { attempts: 2, signal: controller.signal },
      }),
    ).rejects.toBe(reason);
    expect(operation).toHaveBeenCalledOnce();
  });

  it("does not retry create operations by default", async () => {
    const operation = rejecting(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await expect(run(operation, { stage: "create", retry: undefined })).rejects.toThrow("EPIPE");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not start an operation after its retry policy is cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("retry policy cancelled provider read");
    controller.abort(reason);
    const operation = vi.fn(async () => "ok");
    await expect(
      run(operation, { retry: { attempts: 2, signal: controller.signal } }),
    ).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
  });
});
