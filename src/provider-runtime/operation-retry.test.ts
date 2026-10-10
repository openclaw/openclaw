import { describe, expect, it, vi } from "vitest";
import {
  executeProviderOperationWithRetry,
  resolveTransientProviderAttempts,
} from "./operation-retry.js";

describe("resolveTransientProviderAttempts", () => {
  it("does not round malformed attempt counts", () => {
    expect(resolveTransientProviderAttempts({ attempts: 1.5 })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.NaN })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.POSITIVE_INFINITY })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.MAX_SAFE_INTEGER + 1 })).toBe(1);
  });

  it("keeps valid attempt counts as integers", () => {
    expect(resolveTransientProviderAttempts({ attempts: 0 })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: 3 })).toBe(3);
  });
});

describe("executeProviderOperationWithRetry", () => {
  const retry = { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 };
  const connectionError = (code: string) => Object.assign(new Error("connect failed"), { code });

  it("does not turn fractional attempts into an extra execution", async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("HTTP 503"), { status: 503 });
    });

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: { ...retry, attempts: 1.5 },
      }),
    ).rejects.toThrow("HTTP 503");

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

    await expect(
      executeProviderOperationWithRetry({ provider: "test", stage: "read", operation, retry }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["HTTP 400", Object.assign(new Error("Bad Request"), { status: 400 })],
    ["ENOENT", new Error("ENOENT: no such file or directory")],
  ])("does not retry %s failures", async (_label, error) => {
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(error);

    await expect(
      executeProviderOperationWithRetry({ provider: "test", stage: "read", operation, retry }),
    ).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each(["caller", "retry-policy"])(
    "preserves %s cancellation during an operation",
    async (source) => {
      const controller = new AbortController();
      const reason = new Error(`${source} cancelled provider read`);
      const operation = vi.fn(async () => {
        controller.abort(reason);
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      });

      await expect(
        executeProviderOperationWithRetry({
          provider: "test",
          stage: "read",
          operation,
          signal: source === "caller" ? controller.signal : undefined,
          retry: source === "caller" ? retry : { attempts: 2, signal: controller.signal },
        }),
      ).rejects.toBe(reason);

      expect(operation).toHaveBeenCalledOnce();
    },
  );

  it("does not retry create operations by default", async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    await expect(
      executeProviderOperationWithRetry({ provider: "test", stage: "create", operation }),
    ).rejects.toThrow("EPIPE");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not start an operation after its retry policy is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("retry policy cancelled provider read"));
    const operation = vi.fn(async () => "ok");

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: { attempts: 2, signal: controller.signal },
      }),
    ).rejects.toThrow("retry policy cancelled provider read");
    expect(operation).not.toHaveBeenCalled();
  });
});
