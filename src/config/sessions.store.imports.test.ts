import { describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

describe("session store module imports", () => {
  it("does not load archive runtime on module import", async () => {
    const archiveRuntimeLoads = vi.fn();
    vi.doMock("../gateway/session-archive.runtime.js", async () => {
      archiveRuntimeLoads();
      return await vi.importActual<typeof import("../gateway/session-archive.runtime.js")>(
        "../gateway/session-archive.runtime.js",
      );
    });

    await importFreshModule<typeof import("./sessions/store.js")>(
      import.meta.url,
      "./sessions/store.js?scope=no-archive-runtime-on-import",
    );

    expect(archiveRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("../gateway/session-archive.runtime.js");
  });
});
