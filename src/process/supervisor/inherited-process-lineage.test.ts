import { afterEach, describe, expect, it, vi } from "vitest";

describe("inherited process lineage", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("shares one binding across duplicate module instances", async () => {
    // A source host and a dist plugin's natively aliased SDK load separate copies.
    const host = await import("./inherited-process-lineage.js");
    const releaseOwner = host.bindInheritedNativeProcessOwner("file:///owner/anchor.js");
    const releaseFds = host.bindInheritedProcessLineageFds([7, 9]);
    vi.resetModules();
    const plugin = await import("./inherited-process-lineage.js");
    expect(plugin).not.toBe(host);
    expect(plugin.getInheritedNativeProcessOwner()).toBe("file:///owner/anchor.js");
    expect(plugin.getInheritedProcessLineageFds()).toEqual([7, 9]);

    releaseOwner();
    releaseFds();
    expect(plugin.getInheritedNativeProcessOwner()).toBeUndefined();
    expect(plugin.getInheritedProcessLineageFds()).toEqual([]);
  });
});
