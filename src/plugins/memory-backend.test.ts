/** Verifies which plugins the shared backend policy admits beside the memory slot owner. */
import { describe, expect, it } from "vitest";
import { isMemoryBackendRequested, resolveMemoryBackendPolicyIds } from "./memory-backend.js";

const manifests = [
  { id: "memory-fusion", kind: "memory" as const, memoryBackends: true },
  { id: "memory-core", kind: "memory" as const },
  { id: "memory-store", kind: ["memory" as const, "context-engine" as const] },
  { id: "web-tools" },
];

function resolve(overrides: Partial<Parameters<typeof resolveMemoryBackendPolicyIds>[0]> = {}) {
  return resolveMemoryBackendPolicyIds({
    ownerId: "memory-fusion",
    entries: {},
    allow: [],
    deny: [],
    manifests,
    normalizeId: (id) => id.toLowerCase(),
    ...overrides,
  });
}

describe("resolveMemoryBackendPolicyIds", () => {
  it("admits every memory plugin except the owner when the owner manifest asks", () => {
    expect(resolve()).toEqual(["memory-core", "memory-store"]);
  });

  it("admits only explicit entries when the owner manifest does not ask", () => {
    const plain = manifests.map(({ memoryBackends: _ignored, ...rest }) => rest);
    expect(resolve({ manifests: plain })).toEqual([]);
    expect(
      resolve({ manifests: plain, entries: { "memory-core": { memoryBackend: true } } }),
    ).toEqual(["memory-core"]);
  });

  it("honors per-plugin opt-out, disable, deny, and the allowlist", () => {
    expect(resolve({ entries: { "memory-core": { memoryBackend: false } } })).toEqual([
      "memory-store",
    ]);
    expect(resolve({ entries: { "memory-core": { enabled: false } } })).toEqual(["memory-store"]);
    expect(resolve({ deny: ["memory-store"] })).toEqual(["memory-core"]);
    expect(resolve({ allow: ["memory-fusion", "memory-core"] })).toEqual(["memory-core"]);
  });

  it("never lists the owner as its own backend", () => {
    expect(
      resolve({ ownerId: "Memory-Fusion", entries: { "memory-fusion": { memoryBackend: true } } }),
    ).toEqual(["memory-core", "memory-store"]);
  });
});

describe("isMemoryBackendRequested", () => {
  it("follows the owner request unless the entry opts out", () => {
    expect(isMemoryBackendRequested(undefined, "memory-fusion", "memory-core", "full", true)).toBe(
      true,
    );
    expect(isMemoryBackendRequested(undefined, "memory-fusion", "memory-core", "full", false)).toBe(
      false,
    );
    expect(
      isMemoryBackendRequested(
        { memoryBackend: false },
        "memory-fusion",
        "memory-core",
        "full",
        true,
      ),
    ).toBe(false);
    expect(
      isMemoryBackendRequested(undefined, "memory-fusion", "memory-fusion", "full", true),
    ).toBe(false);
    expect(isMemoryBackendRequested(undefined, null, "memory-core", "full", true)).toBe(false);
    expect(
      isMemoryBackendRequested(undefined, "memory-fusion", "memory-core", "setup-only", true),
    ).toBe(false);
  });
});
