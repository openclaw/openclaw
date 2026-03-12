import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const postgresFactoryMock = vi.hoisted(() => vi.fn());

vi.mock("postgres", () => ({
  default: postgresFactoryMock,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfigSnapshot: () => null,
  loadConfig: () => {
    throw new Error("unused in test");
  },
  readBestEffortConfig: async () => null,
}));

vi.mock("../gateway/resolve-configured-secret-input-string.js", () => ({
  resolveConfiguredSecretInputString: vi.fn(async ({ value }: { value?: string }) => ({
    value,
    unresolvedRefReason: undefined,
  })),
}));

const { getPostgresPersistenceForConfig, resetPostgresPersistenceForTest } =
  await import("./postgres-client.js");

describe("postgres persistence client cache", () => {
  beforeEach(() => {
    postgresFactoryMock.mockReset();
  });

  afterEach(async () => {
    await resetPostgresPersistenceForTest();
  });

  it("retries client initialization after a previous ensureReady failure", async () => {
    let attempt = 0;
    postgresFactoryMock.mockImplementation(() => {
      attempt += 1;
      return {
        unsafe: vi.fn(async () => {
          if (attempt === 1) {
            throw new Error("connect failed");
          }
          return [];
        }),
        end: vi.fn(async () => undefined),
      };
    });

    const config = {
      persistence: {
        backend: "postgres" as const,
        postgres: {
          url: "postgresql://openclaw:test@localhost/openclaw",
        },
      },
    };

    await expect(getPostgresPersistenceForConfig({ config })).rejects.toThrow("connect failed");
    await expect(getPostgresPersistenceForConfig({ config })).resolves.toBeTruthy();
    expect(postgresFactoryMock).toHaveBeenCalledTimes(2);
  });
});
