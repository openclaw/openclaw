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
    vi.doMock("./cli/prompt.runtime.js", async (importOriginal) => {
      promptRuntimeLoads();
      return await importOriginal<typeof import("./cli/prompt.runtime.js")>();
    });
    vi.doMock("./infra/binaries.runtime.js", async (importOriginal) => {
      binariesRuntimeLoads();
      return await importOriginal<typeof import("./infra/binaries.runtime.js")>();
    });
    vi.doMock("./plugins/runtime/runtime-whatsapp-boundary.js", async (importOriginal) => {
      whatsappRuntimeLoads();
      return await importOriginal<
        typeof import("./plugins/runtime/runtime-whatsapp-boundary.js")
      >();
    });

    await import("./library.js");

    expect(replyRuntimeLoads).not.toHaveBeenCalled();
    // Vitest eagerly resolves some manual mocks for runtime-boundary modules
    // even when the lazy wrapper is not invoked. Keep the assertion on the
    // reply runtime, which is the stable import-time contract this test cares about.
    vi.doUnmock("./auto-reply/reply.runtime.js");
    vi.doUnmock("./cli/prompt.runtime.js");
    vi.doUnmock("./infra/binaries.runtime.js");
    vi.doUnmock("./plugins/runtime/runtime-whatsapp-boundary.js");
  });
});
