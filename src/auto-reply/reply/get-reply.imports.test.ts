import { beforeEach, describe, expect, it, vi } from "vitest";

describe("get-reply module imports", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not load reset-model runtime on module import", async () => {
    const resetModelRuntimeLoads = vi.fn();
    const sandboxMediaRuntimeLoads = vi.fn();
    vi.doMock("./session-reset-model.runtime.js", async (importOriginal) => {
      resetModelRuntimeLoads();
      return await importOriginal<typeof import("./session-reset-model.runtime.js")>();
    });
    vi.doMock("./stage-sandbox-media.runtime.js", async (importOriginal) => {
      sandboxMediaRuntimeLoads();
      return await importOriginal<typeof import("./stage-sandbox-media.runtime.js")>();
    });

    await import("./get-reply.js");

    expect(resetModelRuntimeLoads).not.toHaveBeenCalled();
    expect(sandboxMediaRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("./session-reset-model.runtime.js");
    vi.doUnmock("./stage-sandbox-media.runtime.js");
  });
});
