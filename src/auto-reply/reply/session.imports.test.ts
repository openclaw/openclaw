import { beforeEach, describe, expect, it, vi } from "vitest";

describe("reply session module imports", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not load archive runtime on module import", async () => {
    const archiveRuntimeLoads = vi.fn();
    vi.doMock("../../gateway/session-archive.runtime.js", async (importOriginal) => {
      archiveRuntimeLoads();
      return await importOriginal<typeof import("../../gateway/session-archive.runtime.js")>();
    });

    await import("./session.js");

    expect(archiveRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("../../gateway/session-archive.runtime.js");
  });
});
