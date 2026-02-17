import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuotaStore } from "./types.js";
import { checkQuota, deductQuota } from "./check.js";
import { resolveCustomerId } from "./identity.js";
import { resetQuotaStore } from "./store.js";

// Mock store that we inject via the store factory
const mockStore: QuotaStore = {
  getUsage: vi.fn(),
  incrementUsage: vi.fn(),
  setCustomer: vi.fn(),
  close: vi.fn(),
};

vi.mock("./store.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./store.js")>();
  return {
    ...orig,
    getQuotaStore: vi.fn(async (config: unknown) => {
      const cfg = config as { quota?: { enabled?: boolean } };
      if (!cfg?.quota?.enabled) {
        return null;
      }
      return mockStore;
    }),
  };
});

const baseConfig = {
  quota: {
    enabled: true,
    defaultPlan: "free",
    plans: {
      free: { tokenLimit: 100_000 },
      pro: { tokenLimit: 1_000_000, label: "Pro" },
    },
    storage: { backend: "dynamodb" as const, dynamodb: { tableName: "test" } },
  },
};

describe("checkQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when quota is disabled", async () => {
    const result = await checkQuota("cust-1", { quota: { enabled: false } });
    expect(result).toBeNull();
  });

  it("returns quota status for a known customer", async () => {
    vi.mocked(mockStore.getUsage).mockResolvedValue({ tokensUsed: 50_000, plan: "free" });

    const result = await checkQuota("cust-1", baseConfig);
    expect(result).toEqual({
      customerId: "cust-1",
      plan: "free",
      tokenLimit: 100_000,
      tokensUsed: 50_000,
      tokensRemaining: 50_000,
      exceeded: false,
    });
  });

  it("marks exceeded when tokens used >= limit", async () => {
    vi.mocked(mockStore.getUsage).mockResolvedValue({ tokensUsed: 100_000, plan: "free" });

    const result = await checkQuota("cust-1", baseConfig);
    expect(result?.exceeded).toBe(true);
    expect(result?.tokensRemaining).toBe(0);
  });

  it("marks exceeded when tokens used exceed limit", async () => {
    vi.mocked(mockStore.getUsage).mockResolvedValue({ tokensUsed: 150_000, plan: "free" });

    const result = await checkQuota("cust-1", baseConfig);
    expect(result?.exceeded).toBe(true);
    expect(result?.tokensRemaining).toBe(0);
  });

  it("falls back to defaultPlan when customer has no plan", async () => {
    vi.mocked(mockStore.getUsage).mockResolvedValue(null);

    const result = await checkQuota("new-cust", baseConfig);
    expect(result?.plan).toBe("free");
    expect(result?.tokenLimit).toBe(100_000);
    expect(result?.tokensUsed).toBe(0);
  });

  it("returns null when plan config is missing", async () => {
    vi.mocked(mockStore.getUsage).mockResolvedValue({ tokensUsed: 0, plan: "unknown" });

    const result = await checkQuota("cust-1", baseConfig);
    expect(result).toBeNull();
  });
});

describe("deductQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments usage for a customer", async () => {
    await deductQuota("cust-1", 5_000, baseConfig);
    expect(mockStore.incrementUsage).toHaveBeenCalledWith("cust-1", 5_000);
  });

  it("does nothing when quota is disabled", async () => {
    await deductQuota("cust-1", 5_000, { quota: { enabled: false } });
    expect(mockStore.incrementUsage).not.toHaveBeenCalled();
  });
});

describe("resolveCustomerId", () => {
  afterEach(() => {
    delete process.env.OPENCLAW_CUSTOMER_ID;
    delete process.env.MY_CUST_ID;
  });

  it("resolves from OPENCLAW_CUSTOMER_ID env var", () => {
    process.env.OPENCLAW_CUSTOMER_ID = "env-cust-1";
    const result = resolveCustomerId({ config: {} });
    expect(result).toBe("env-cust-1");
  });

  it("resolves from custom env var name", () => {
    process.env.MY_CUST_ID = "env-cust-2";
    const result = resolveCustomerId({
      config: { quota: { customerEnvVar: "MY_CUST_ID" } },
    });
    expect(result).toBe("env-cust-2");
  });

  it("env var takes priority over header and senderId", () => {
    process.env.OPENCLAW_CUSTOMER_ID = "env-cust-1";
    const result = resolveCustomerId({
      config: {},
      senderId: "sender-789",
      headers: { "x-customer-id": "header-cust" },
    });
    expect(result).toBe("env-cust-1");
  });

  it("resolves from custom header when env var not set", () => {
    const result = resolveCustomerId({
      config: { quota: { customerHeader: "x-tenant-id" } },
      headers: { "x-tenant-id": "tenant-123" },
    });
    expect(result).toBe("tenant-123");
  });

  it("resolves from default x-customer-id header", () => {
    const result = resolveCustomerId({
      config: {},
      headers: { "x-customer-id": "cust-456" },
    });
    expect(result).toBe("cust-456");
  });

  it("falls back to senderId", () => {
    const result = resolveCustomerId({
      config: {},
      senderId: "sender-789",
    });
    expect(result).toBe("sender-789");
  });

  it("returns null when no identity source available", () => {
    const result = resolveCustomerId({ config: {} });
    expect(result).toBeNull();
  });

  it("prefers header over senderId", () => {
    const result = resolveCustomerId({
      config: {},
      senderId: "sender-789",
      headers: { "x-customer-id": "header-cust" },
    });
    expect(result).toBe("header-cust");
  });
});
