import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

afterEach(() => {
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.doUnmock("../../logging/subsystem.js");
});

describe("bundled channel entry shape guards", () => {
  it("treats missing bundled discovery results as empty", async () => {
    vi.doMock("../../plugins/discovery.js", () => ({
      discoverOpenClawPlugins: () => ({
        candidates: [],
        diagnostics: [],
      }),
    }));
    vi.doMock("../../plugins/manifest-registry.js", () => ({
      loadPluginManifestRegistry: () => ({
        plugins: [],
        diagnostics: [],
      }),
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=missing-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });

  it("loads bundled signal, slack, and whatsapp entries without recursive load warnings", async () => {
    const warn = vi.fn();
    vi.doMock("../../logging/subsystem.js", () => ({
      createSubsystemLogger: () => ({
        warn,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=real-bundled-recursive-load-warnings",
    );

    expect(bundled.listBundledChannelPlugins().map((plugin) => plugin.id)).toEqual(
      expect.arrayContaining(["signal", "slack", "whatsapp"]),
    );
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("failed to load bundled channel signal"),
      ),
    ).toBe(false);
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("failed to load bundled channel slack"),
      ),
    ).toBe(false);
    expect(
      warn.mock.calls.some(([message]) =>
        String(message).includes("failed to load bundled channel whatsapp"),
      ),
    ).toBe(false);
  });
});
