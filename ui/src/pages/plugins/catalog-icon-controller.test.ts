/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";

const fetchIcon = vi.hoisted(() => vi.fn());

vi.mock("./icon-loader.ts", () => ({
  fetchCatalogIconBlobUrl: (...args: unknown[]) => fetchIcon(...args),
}));

const { PluginIconController } = await import("./plugin-icon-controller.ts");

const entry = {
  id: "ch_dGVzdA",
  catalog: {
    name: "Test",
    official: false,
    categories: ["tools"],
    imageUrl: "https://cdn.example.com/test.png",
  },
  local: {
    present: false,
    installed: false,
    enabled: false,
    state: "not-installed",
    action: "install",
  },
} satisfies PluginDiscoveryEntry;

function createController(
  onUrlsChange: (urls: Record<string, string>) => void,
  onLoadingChange?: () => void,
) {
  return new PluginIconController({
    kind: "catalog",
    getFetchContext: () => ({ gatewayUrl: "ws://localhost", resourceBasePath: "", auth: {} }),
    isConnected: () => true,
    onUrlsChange,
    onLoadingChange,
  });
}

describe("catalog icon lifecycle", () => {
  beforeEach(() => fetchIcon.mockReset());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes proxied catalog icons and revokes them when the entry leaves", async () => {
    fetchIcon.mockResolvedValue("blob:test-icon");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const published: Array<Record<string, string>> = [];
    const controller = createController((urls) => published.push(urls));

    controller.syncCatalog([entry]);
    expect(controller.isLoading(entry.catalog.imageUrl)).toBe(true);
    await vi.waitFor(() =>
      expect(published.at(-1)).toEqual({
        "https://cdn.example.com/test.png": "blob:test-icon",
      }),
    );

    expect(controller.isLoading(entry.catalog.imageUrl)).toBe(false);
    controller.syncCatalog([]);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-icon");
    expect(published.at(-1)).toEqual({});
  });

  it.each(["empty", "error"])("retains a %s miss across removal until reset", async (kind) => {
    fetchIcon.mockImplementationOnce(() =>
      kind === "empty" ? Promise.resolve(null) : Promise.reject(new Error("failed")),
    );
    const controller = createController(() => undefined);
    controller.syncCatalog([entry]);
    await vi.waitFor(() => expect(controller.isLoading(entry.catalog.imageUrl)).toBe(false));
    controller.syncCatalog([]);
    controller.syncCatalog([entry]);
    expect(fetchIcon).toHaveBeenCalledOnce();
    controller.reset();
    fetchIcon.mockResolvedValueOnce(null);
    controller.syncCatalog([entry]);
    expect(fetchIcon).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(controller.isLoading(entry.catalog.imageUrl)).toBe(false));
  });

  it.each(["success", "error"])(
    "keeps slow reads alive and retires a late %s safely",
    async (outcome) => {
      const events: string[] = [];
      vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
        events.push(`revoke:${url}`);
      });
      const published = vi.fn(() => {
        events.push("urls");
      });
      const controller = createController(published, () => {
        events.push("loading");
      });
      fetchIcon.mockResolvedValueOnce("blob:first");
      controller.syncCatalog([entry]);
      await vi.waitFor(() => expect(controller.isLoading(entry.catalog.imageUrl)).toBe(false));
      vi.useFakeTimers();
      let resolveSlow!: (value: string) => void;
      let rejectSlow!: (error: Error) => void;
      const slow = "https://cdn.example.com/slow.png";
      let signal!: AbortSignal;
      fetchIcon.mockImplementationOnce((params: { signal: AbortSignal }) => {
        signal = params.signal;
        signal.addEventListener("abort", () => {
          events.push("abort");
        });
        return new Promise<string>((resolve, reject) => {
          resolveSlow = resolve;
          rejectSlow = reject;
        });
      });
      controller.syncCatalog([entry], [slow]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal.aborted).toBe(false);
      expect(controller.isLoading(slow)).toBe(true);
      events.length = 0;
      controller.syncCatalog([]);
      expect(events).toEqual(["revoke:blob:first", "abort", "loading", "urls"]);
      events.length = 0;
      controller.reset();
      events.length = 0;
      if (outcome === "success") {
        resolveSlow("blob:late");
      } else {
        rejectSlow(new Error("aborted"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(outcome === "success" ? ["revoke:blob:late"] : []);
      expect(published).toHaveBeenLastCalledWith({});
      events.length = 0;
      controller.reset();
      controller.reset();
      expect(events).toEqual(["loading", "loading"]);
      fetchIcon.mockResolvedValueOnce("blob:retry");
      controller.syncCatalog([], [slow]);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchIcon).toHaveBeenCalledTimes(3);
      expect(published).toHaveBeenLastCalledWith({ [slow]: "blob:retry" });
      controller.reset();
    },
  );
});
