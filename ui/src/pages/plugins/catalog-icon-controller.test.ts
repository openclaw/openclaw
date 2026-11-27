/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { matrixDiscoveryPlugin } from "../../test-helpers/plugins-e2e-fixtures.test-support.ts";

const fetchIcon = vi.hoisted(() => vi.fn());
// mock-isolation: control icon fetch settlement without real browser Blob or network I/O.
vi.mock("./icon-loader.ts", () => ({ fetchCatalogIconBlobUrl: fetchIcon }));

const { PluginIconOwner } = await import("./plugin-icon-owner.ts");
const imageUrl = "https://cdn.example.com/test.png";
const entry = {
  ...matrixDiscoveryPlugin,
  catalog: { ...matrixDiscoveryPlugin.catalog, imageUrl },
};

let controller: InstanceType<typeof PluginIconOwner>;
const events: string[] = [];
const published = vi.fn(() => events.push("urls"));
const settled = () => vi.waitFor(() => expect(controller.isLoading(imageUrl)).toBe(false));

beforeEach(() => {
  fetchIcon.mockReset();
  published.mockClear();
  events.length = 0;
  controller = new PluginIconOwner({
    kind: "catalog",
    getFetchContext: () => ({ gatewayUrl: "ws://localhost", resourceBasePath: "", auth: {} }),
    isConnected: () => true,
    onUrlsChange: published,
    onLoadingChange: () => events.push("loading"),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("publishes proxied catalog icons and revokes them when the entry leaves", async () => {
  fetchIcon.mockResolvedValue("blob:icon");
  const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

  controller.syncCatalog([entry], [], new Set());
  expect(fetchIcon).not.toHaveBeenCalled();
  controller.syncCatalog([entry], [], new Set([entry.id]));
  expect(controller.isLoading(imageUrl)).toBe(true);
  await vi.waitFor(() => expect(published).toHaveBeenLastCalledWith({ [imageUrl]: "blob:icon" }));

  expect(controller.isLoading(imageUrl)).toBe(false);
  controller.syncCatalog([entry], [], new Set());
  expect(revokeObjectURL).not.toHaveBeenCalled();
  controller.syncCatalog([entry], [], new Set([entry.id]));
  expect(fetchIcon).toHaveBeenCalledOnce();
  controller.syncCatalog([]);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:icon");
  expect(published).toHaveBeenLastCalledWith({});
});

it.each(["empty", "error"])("retains a %s miss across removal until reset", async (kind) => {
  fetchIcon.mockImplementationOnce(() =>
    kind === "empty" ? Promise.resolve(null) : Promise.reject(new Error("failed")),
  );
  controller.syncCatalog([entry]);
  await settled();
  controller.syncCatalog([]);
  controller.syncCatalog([entry]);
  expect(fetchIcon).toHaveBeenCalledOnce();
  controller.reset();
  fetchIcon.mockResolvedValueOnce(null);
  controller.syncCatalog([entry]);
  expect(fetchIcon).toHaveBeenCalledTimes(2);
  await settled();
});

it.each(["success", "error"])("retires late %s without timing out", async (outcome) => {
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => events.push(`revoke:${url}`));
  fetchIcon.mockResolvedValueOnce("blob:first");
  controller.syncCatalog([entry]);
  await settled();
  vi.useFakeTimers();
  const pending = createDeferred<string>();
  const slow = "https://cdn.example.com/slow.png";
  let signal!: AbortSignal;
  fetchIcon.mockImplementationOnce((params: { signal: AbortSignal }) => {
    signal = params.signal;
    signal.addEventListener("abort", () => events.push("abort"));
    return pending.promise;
  });
  controller.syncCatalog([entry], [slow]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(signal.aborted).toBe(false);
  expect(controller.isLoading(slow)).toBe(true);
  events.length = 0;
  controller.syncCatalog([]);
  expect(events).toEqual(["revoke:blob:first", "abort", "loading", "urls"]);
  controller.reset();
  events.length = 0;
  if (outcome === "success") {
    pending.resolve("blob:late");
  } else {
    pending.reject(new Error("aborted"));
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
});
