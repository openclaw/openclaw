import { describe, expect, it, vi } from "vitest";
import type { WorkerProvider, WorkerSshIdentity } from "../../plugins/types.js";
import { resolveWorkerSshIdentity } from "./identity.js";

const KEY_REF = { source: "file", provider: "worker", id: "/lease" } as const;
const PROFILE = { provider: "example" };
function resolveIdentity(overrides: Partial<Parameters<typeof resolveWorkerSshIdentity>[0]>) {
  const controller = new AbortController();
  return resolveWorkerSshIdentity({
    provider: provider(),
    leaseId: "lease-1",
    profile: PROFILE,
    keyRef: KEY_REF,
    assertAuthorized: () => controller.signal.throwIfAborted(),
    resolveGeneric: vi.fn(),
    ...overrides,
  });
}

function provider(overrides: Partial<WorkerProvider> = {}): WorkerProvider {
  return {
    id: "example",
    resolveAllocation: vi.fn(),
    provision: vi.fn(),
    inspect: vi.fn(),
    destroy: vi.fn(),
    ...overrides,
  };
}

describe("resolveWorkerSshIdentity", () => {
  it("uses the provider-owned resolver with durable lease context", async () => {
    const identity: WorkerSshIdentity = { kind: "path", path: "/keys/lease" };
    const resolveSshIdentity = vi.fn(async () => identity);
    const controller = new AbortController();
    const assertAuthorized = () => controller.signal.throwIfAborted();
    const resolveGeneric = vi.fn(async () => ({ kind: "material", contents: "unused" }) as const);

    await expect(
      resolveIdentity({
        provider: provider({ resolveSshIdentity }),
        assertAuthorized,
        resolveGeneric,
      }),
    ).resolves.toEqual(identity);

    expect(resolveSshIdentity).toHaveBeenCalledWith({
      leaseId: "lease-1",
      profile: PROFILE,
      keyRef: KEY_REF,
      assertCurrent: assertAuthorized,
    });
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it("uses the generic resolver when the provider has no resolver", async () => {
    const identity: WorkerSshIdentity = {
      kind: "material",
      contents: ["part", "value"].join("-"),
    };
    const controller = new AbortController();
    const assertAuthorized = () => controller.signal.throwIfAborted();
    const resolveGeneric = vi.fn(async () => identity);

    await expect(resolveIdentity({ assertAuthorized, resolveGeneric })).resolves.toEqual(identity);
    expect(resolveGeneric).toHaveBeenCalledWith(KEY_REF, assertAuthorized);
  });

  it("fails closed when the provider resolver rejects", async () => {
    const resolveGeneric = vi.fn();

    await expect(
      resolveIdentity({
        provider: provider({
          resolveSshIdentity: async () => {
            throw new Error("provider identity unavailable");
          },
        }),
        resolveGeneric,
      }),
    ).rejects.toThrow("provider identity unavailable");
    expect(resolveGeneric).not.toHaveBeenCalled();
  });

  it.each(["provider", "generic"] as const)(
    "rejects a late %s identity without falling back",
    async (owner) => {
      const controller = new AbortController();
      const closed = new Error("identity invocation closed");
      const resolve = async () => {
        controller.abort(closed);
        return { kind: "material" as const, contents: "synthetic-worker-key" };
      };
      const resolveGeneric = vi.fn(resolve);
      await expect(
        resolveIdentity({
          provider: provider(owner === "provider" ? { resolveSshIdentity: resolve } : {}),
          assertAuthorized: () => controller.signal.throwIfAborted(),
          resolveGeneric,
        }),
      ).rejects.toBe(closed);
      expect(resolveGeneric).toHaveBeenCalledTimes(owner === "generic" ? 1 : 0);
    },
  );
});
