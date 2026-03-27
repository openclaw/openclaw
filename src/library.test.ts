import { beforeEach, describe, expect, it, vi } from "vitest";

describe("library module imports", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not load lazy runtimes on module import", async () => {
    const replyRuntimeLoads = vi.fn();
    const promptRuntimeLoads = vi.fn();
    const binariesRuntimeLoads = vi.fn();
    const whatsappRuntimeLoads = vi.fn();
    vi.doMock("./auto-reply/reply.runtime.js", async (importOriginal) => {
      replyRuntimeLoads();
      return await importOriginal<typeof import("./auto-reply/reply.runtime.js")>();
    });
    vi.doMock("./cli/prompt.js", async (importOriginal) => {
      promptRuntimeLoads();
      return await importOriginal<typeof import("./cli/prompt.js")>();
    });
    vi.doMock("./infra/binaries.js", async (importOriginal) => {
      binariesRuntimeLoads();
      return await importOriginal<typeof import("./infra/binaries.js")>();
    });
    vi.doMock("./plugins/runtime/runtime-whatsapp-boundary.js", async (importOriginal) => {
      whatsappRuntimeLoads();
      return await importOriginal<
        typeof import("./plugins/runtime/runtime-whatsapp-boundary.js")
      >();
    });

    await import("./library.js");

    expect(replyRuntimeLoads).not.toHaveBeenCalled();
    expect(promptRuntimeLoads).not.toHaveBeenCalled();
    expect(binariesRuntimeLoads).not.toHaveBeenCalled();
    expect(whatsappRuntimeLoads).not.toHaveBeenCalled();
    vi.doUnmock("./auto-reply/reply.runtime.js");
    vi.doUnmock("./cli/prompt.js");
    vi.doUnmock("./infra/binaries.js");
    vi.doUnmock("./plugins/runtime/runtime-whatsapp-boundary.js");
  });
});
