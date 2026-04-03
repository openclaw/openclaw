import { describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

describe("reply session module imports", () => {
  it("does not load archive runtime on module import", async () => {
    const archiveRuntimeLoads = vi.fn();
    vi.doMock("../../gateway/session-archive.runtime.js", async (importOriginal) => {
      archiveRuntimeLoads();
      return await importOriginal<typeof import("../../gateway/session-archive.runtime.js")>();
    });

    await importFreshModule<typeof import("./session.js")>(
      import.meta.url,
      "./session.js?scope=no-archive-runtime-on-import",
    );

    expect(archiveRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("../../gateway/session-archive.runtime.js");
  });
});
