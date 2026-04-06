import { describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

describe("get-reply module imports", () => {
  it("does not load reset-model runtime on module import", async () => {
    const resetModelRuntimeLoads = vi.fn();
    const sandboxMediaRuntimeLoads = vi.fn();
    vi.doMock("./session-reset-model.runtime.js", async () => {
      resetModelRuntimeLoads();
      return await vi.importActual<typeof import("./session-reset-model.runtime.js")>(
        "./session-reset-model.runtime.js",
      );
    });
    vi.doMock("./stage-sandbox-media.runtime.js", async () => {
      sandboxMediaRuntimeLoads();
      return await vi.importActual<typeof import("./stage-sandbox-media.runtime.js")>(
        "./stage-sandbox-media.runtime.js",
      );
    });

    await importFreshModule<typeof import("./get-reply.js")>(
      import.meta.url,
      "./get-reply.js?scope=no-runtime-imports",
    );

    expect(resetModelRuntimeLoads).not.toHaveBeenCalled();
    expect(sandboxMediaRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("./session-reset-model.runtime.js");
    vi.doUnmock("./stage-sandbox-media.runtime.js");
  });
});
