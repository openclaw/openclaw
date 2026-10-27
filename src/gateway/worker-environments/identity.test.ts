import { expect, it, vi } from "vitest";
import { resolveWorkerSshIdentity } from "./identity.js";

const KEY_REF = { source: "file", provider: "worker", id: "/lease" } as const;
const PROFILE = { provider: "example" };
type IdentityRequest = Parameters<typeof resolveWorkerSshIdentity>[0];

function fixture() {
  const controller = new AbortController();
  const resolveGeneric = vi.fn<IdentityRequest["resolveGeneric"]>();
  const request: IdentityRequest = {
    provider: {
      id: "example",
      resolveAllocation: vi.fn(),
      provision: vi.fn(),
      inspect: vi.fn(),
      destroy: vi.fn(),
    },
    leaseId: "lease-1",
    profile: PROFILE,
    keyRef: KEY_REF,
    assertAuthorized: () => controller.signal.throwIfAborted(),
    resolveGeneric,
  };
  return { request, controller, resolveGeneric };
}

it.each([
  ["provider", { kind: "path", path: "/keys/lease" }],
  ["generic", { kind: "material", contents: "part-value" }],
] as const)("resolves the %s-owned SSH identity with its context", async (owner, identity) => {
  const { request, resolveGeneric } = fixture();
  const resolve = vi.fn(async () => identity);
  if (owner === "provider") {
    request.provider.resolveSshIdentity = resolve;
  } else {
    request.resolveGeneric = resolve;
  }
  await expect(resolveWorkerSshIdentity(request)).resolves.toEqual(identity);
  if (owner === "provider") {
    expect(resolve).toHaveBeenCalledWith({
      leaseId: "lease-1",
      profile: PROFILE,
      keyRef: KEY_REF,
      assertCurrent: request.assertAuthorized,
    });
    expect(resolveGeneric).not.toHaveBeenCalled();
  } else {
    expect(resolve).toHaveBeenCalledWith(KEY_REF, request.assertAuthorized);
  }
});

it("fails closed when the provider resolver rejects", async () => {
  const { request, resolveGeneric } = fixture();
  request.provider.resolveSshIdentity = async () => {
    throw new Error("provider identity unavailable");
  };
  await expect(resolveWorkerSshIdentity(request)).rejects.toThrow("provider identity unavailable");
  expect(resolveGeneric).not.toHaveBeenCalled();
});

it.each(["provider", "generic"] as const)(
  "rejects a late %s identity without fallback",
  async (owner) => {
    const { request, controller, resolveGeneric } = fixture();
    const closed = new Error("identity invocation closed");
    const resolve = async () => {
      controller.abort(closed);
      return { kind: "material" as const, contents: "synthetic-worker-key" };
    };
    if (owner === "provider") {
      request.provider.resolveSshIdentity = resolve;
    }
    resolveGeneric.mockImplementation(resolve);
    await expect(resolveWorkerSshIdentity(request)).rejects.toBe(closed);
    expect(resolveGeneric).toHaveBeenCalledTimes(owner === "generic" ? 1 : 0);
  },
);
