import { describe, expect, it, vi } from "vitest";
import type { WorkerProviderV1, WorkerSshIdentity } from "../../plugins/types.js";
import { resolveWorkerSshIdentity } from "./identity.js";

const KEY_REF = { source: "file", provider: "worker", id: "/lease" } as const;
const PROFILE = { provider: "example" };

function provider(overrides: Partial<WorkerProviderV1> = {}): WorkerProviderV1 {
  return {
    id: "example",
    liveAuthorityVersion: 1,
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
      resolveWorkerSshIdentity({
        provider: provider({ resolveSshIdentity }),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
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

    await expect(
      resolveWorkerSshIdentity({
        provider: provider(),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized,
        resolveGeneric,
      }),
    ).resolves.toEqual(identity);
    expect(resolveGeneric).toHaveBeenCalledWith(KEY_REF, assertAuthorized);
  });

  it("fails closed when the provider resolver rejects", async () => {
    const controller = new AbortController();
    const assertAuthorized = () => controller.signal.throwIfAborted();
    const resolveGeneric = vi.fn();

    await expect(
      resolveWorkerSshIdentity({
        provider: provider({
          resolveSshIdentity: async () => {
            throw new Error("provider identity unavailable");
          },
        }),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized,
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
      const request = {
        provider: provider(owner === "provider" ? { resolveSshIdentity: resolve } : {}),
        leaseId: "lease-1",
        profile: PROFILE,
        keyRef: KEY_REF,
        assertAuthorized: () => controller.signal.throwIfAborted(),
        resolveGeneric,
      };
      await expect(resolveWorkerSshIdentity(request)).rejects.toBe(closed);
      expect(resolveGeneric).toHaveBeenCalledTimes(owner === "generic" ? 1 : 0);
    },
  );
});
