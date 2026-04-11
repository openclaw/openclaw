import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadGuardrailProvider, configureGuardrails } = vi.hoisted(() => ({
  loadGuardrailProvider: vi.fn(),
  configureGuardrails: vi.fn(),
}));

vi.mock("../../src/guardrails/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/guardrails/index.js")>(
    "../../src/guardrails/index.js",
  );
  return {
    ...actual,
    loadGuardrailProvider,
  };
});

vi.mock("../../src/guardrails/runtime.js", () => ({
  configureGuardrails,
}));

import { __testing, initGuardrailsFromConfig } from "../../src/guardrails/init.js";

function flushPromises() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createDeferredPromise<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("initGuardrailsFromConfig", () => {
  beforeEach(() => {
    __testing.resetGuardrailsInitState();
    loadGuardrailProvider.mockReset();
    configureGuardrails.mockReset();
    log.info.mockReset();
    log.warn.mockReset();
    log.error.mockReset();
  });

  it("deduplicates repeated init for the same config while provider is active", async () => {
    loadGuardrailProvider.mockResolvedValue({
      name: "allowlist",
      evaluate: vi.fn(async () => ({ allow: true })),
    });

    const cfg = {
      enabled: true,
      provider: { use: "builtin:allowlist", config: { deniedTools: ["exec"] } },
    };

    initGuardrailsFromConfig(cfg, log);
    await flushPromises();
    initGuardrailsFromConfig(cfg, log);
    await flushPromises();

    expect(loadGuardrailProvider).toHaveBeenCalledTimes(1);
  });

  it("retries the same config after a provider load failure", async () => {
    loadGuardrailProvider.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      name: "allowlist",
      evaluate: vi.fn(async () => ({ allow: true })),
    });

    const cfg = {
      enabled: true,
      provider: { use: "builtin:allowlist" },
    };

    initGuardrailsFromConfig(cfg, log);
    await flushPromises();
    initGuardrailsFromConfig(cfg, log);
    await flushPromises();

    expect(loadGuardrailProvider).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith("[guardrails] failed to load provider: boom");
    expect(log.info).toHaveBeenCalledWith(
      "[guardrails] provider 'allowlist' loaded (failClosed=true)",
    );
  });

  it("clears runtime state when guardrails are disabled", async () => {
    loadGuardrailProvider.mockResolvedValue({
      name: "allowlist",
      evaluate: vi.fn(async () => ({ allow: true })),
    });

    const cfg = {
      enabled: true,
      provider: { use: "builtin:allowlist" },
    };

    initGuardrailsFromConfig(cfg, log);
    await flushPromises();
    initGuardrailsFromConfig({ enabled: false }, log);
    await flushPromises();
    initGuardrailsFromConfig(cfg, log);
    await flushPromises();

    expect(configureGuardrails).toHaveBeenCalledWith(undefined);
    expect(loadGuardrailProvider).toHaveBeenCalledTimes(2);
  });

  it("installs a failed-load placeholder when fail-closed provider load fails", async () => {
    loadGuardrailProvider.mockRejectedValue(new Error("boom"));

    initGuardrailsFromConfig(
      {
        enabled: true,
        failClosed: true,
        provider: { use: "builtin:allowlist" },
      },
      log,
    );
    await flushPromises();

    expect(configureGuardrails).toHaveBeenCalledTimes(2);

    const pendingProvider = configureGuardrails.mock.calls[0][0];
    const failedProvider = configureGuardrails.mock.calls[1][0];

    await expect(pendingProvider.evaluate()).resolves.toMatchObject({
      allow: false,
      reasons: [{ code: "provider_loading", message: "guardrail provider is still loading" }],
    });
    await expect(failedProvider.evaluate()).resolves.toMatchObject({
      allow: false,
      reasons: [
        { code: "provider_load_failed", message: "guardrail provider failed to load (see logs)" },
      ],
    });
  });

  it("ignores stale async load results after a newer config takes over", async () => {
    const deferred = createDeferredPromise<{
      name: string;
      evaluate: () => Promise<{ allow: boolean }>;
    }>();

    loadGuardrailProvider
      .mockImplementationOnce(() => deferred.promise)
      .mockResolvedValueOnce({
        name: "allowlist-browser",
        evaluate: vi.fn(async () => ({ allow: true })),
      });

    initGuardrailsFromConfig(
      {
        enabled: true,
        provider: { use: "builtin:allowlist", config: { deniedTools: ["exec"] } },
      },
      log,
    );
    initGuardrailsFromConfig(
      {
        enabled: true,
        provider: { use: "builtin:allowlist", config: { deniedTools: ["browser"] } },
      },
      log,
    );

    await flushPromises();

    expect(configureGuardrails).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith(
      "[guardrails] provider 'allowlist-browser' loaded (failClosed=true)",
    );

    deferred.reject(new Error("stale boom"));
    await flushPromises();

    expect(configureGuardrails).toHaveBeenCalledTimes(3);
    expect(log.error).not.toHaveBeenCalledWith("[guardrails] failed to load provider: stale boom");
  });

  it("clears a fail-closed pending provider when switching to fail-open", async () => {
    const firstDeferred = createDeferredPromise<{
      name: string;
      evaluate: () => Promise<{ allow: boolean }>;
    }>();

    loadGuardrailProvider
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockResolvedValueOnce({
        name: "allowlist-fail-open",
        evaluate: vi.fn(async () => ({ allow: true })),
      });

    initGuardrailsFromConfig(
      {
        enabled: true,
        failClosed: true,
        provider: { use: "builtin:allowlist", config: { deniedTools: ["exec"] } },
      },
      log,
    );

    initGuardrailsFromConfig(
      {
        enabled: true,
        failClosed: false,
        provider: { use: "builtin:allowlist", config: { deniedTools: ["browser"] } },
      },
      log,
    );

    await flushPromises();

    expect(configureGuardrails).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "guardrails-pending" }),
      true,
    );
    expect(configureGuardrails).toHaveBeenNthCalledWith(2, undefined, false);
    expect(configureGuardrails).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ name: "allowlist-fail-open" }),
      false,
    );
  });

  it("ignores stale callbacks from earlier init generations when the same config is retried", async () => {
    const firstDeferred = createDeferredPromise<{
      name: string;
      evaluate: () => Promise<{ allow: boolean }>;
    }>();
    const secondDeferred = createDeferredPromise<{
      name: string;
      evaluate: () => Promise<{ allow: boolean }>;
    }>();
    const cfg = {
      enabled: true,
      provider: { use: "builtin:allowlist", config: { deniedTools: ["exec"] } },
    };

    loadGuardrailProvider
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

    initGuardrailsFromConfig(cfg, log);
    initGuardrailsFromConfig({ enabled: false }, log);
    initGuardrailsFromConfig(cfg, log);

    await flushPromises();

    expect(configureGuardrails).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "guardrails-pending" }),
      true,
    );
    expect(configureGuardrails).toHaveBeenNthCalledWith(2, undefined);
    expect(configureGuardrails).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ name: "guardrails-pending" }),
      true,
    );

    firstDeferred.reject(new Error("stale boom"));
    await flushPromises();

    expect(configureGuardrails).toHaveBeenCalledTimes(3);
    expect(log.error).not.toHaveBeenCalledWith("[guardrails] failed to load provider: stale boom");

    secondDeferred.resolve({
      name: "allowlist-reloaded",
      evaluate: vi.fn(async () => ({ allow: true })),
    });
    await flushPromises();

    expect(configureGuardrails).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ name: "allowlist-reloaded" }),
      true,
    );
    expect(log.info).toHaveBeenCalledWith(
      "[guardrails] provider 'allowlist-reloaded' loaded (failClosed=true)",
    );
  });
});
