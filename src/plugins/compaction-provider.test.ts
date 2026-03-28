import { afterEach, describe, expect, it } from "vitest";
import {
  getCompactionProvider,
  listCompactionProviderIds,
  registerCompactionProvider,
  type CompactionProvider,
} from "./compaction-provider.js";

const REGISTRY_KEY = Symbol.for("openclaw.compactionProviderRegistryState");

/** Reset the process-global registry between tests. */
afterEach(() => {
  const g = globalThis as Record<symbol, unknown>;
  delete g[REGISTRY_KEY];
});

function makeProvider(id: string, label?: string): CompactionProvider {
  return {
    id,
    label: label ?? id,
    async summarize() {
      return `summary-from-${id}`;
    },
  };
}

describe("compaction provider registry", () => {
  it("starts empty", () => {
    expect(listCompactionProviderIds()).toEqual([]);
  });

  it("returns undefined for an unknown id", () => {
    expect(getCompactionProvider("nonexistent")).toBeUndefined();
  });

  it("registers and retrieves a provider", () => {
    const p = makeProvider("test-compactor");
    registerCompactionProvider(p);

    expect(getCompactionProvider("test-compactor")).toBe(p);
  });

  it("lists registered provider ids", () => {
    registerCompactionProvider(makeProvider("alpha"));
    registerCompactionProvider(makeProvider("beta"));

    expect(listCompactionProviderIds()).toEqual(["alpha", "beta"]);
  });

  it("supports multiple providers", () => {
    registerCompactionProvider(makeProvider("a"));
    registerCompactionProvider(makeProvider("b"));
    registerCompactionProvider(makeProvider("c"));

    expect(getCompactionProvider("a")?.id).toBe("a");
    expect(getCompactionProvider("b")?.id).toBe("b");
    expect(getCompactionProvider("c")?.id).toBe("c");
    expect(listCompactionProviderIds()).toHaveLength(3);
  });

  it("calls summarize and returns expected result", async () => {
    registerCompactionProvider(makeProvider("my-compactor"));

    const provider = getCompactionProvider("my-compactor");
    const result = await provider!.summarize({ messages: [] });

    expect(result).toBe("summary-from-my-compactor");
  });

  it("overwrites when re-registering the same id", () => {
    const first = makeProvider("dup", "first-label");
    const second = makeProvider("dup", "second-label");

    registerCompactionProvider(first);
    registerCompactionProvider(second);

    expect(getCompactionProvider("dup")).toBe(second);
    expect(getCompactionProvider("dup")?.label).toBe("second-label");
    expect(listCompactionProviderIds()).toEqual(["dup"]);
  });
});
