import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { PlaceBrowserState, PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";

function directory(path: string, names: string[], parent = "/workspace"): FsListDirResult {
  return {
    path,
    parent,
    home: "/home/test",
    entries: names.map((name) => ({ name, path: `${path}/${name}` })),
  };
}
const workspace = directory("/workspace", ["packages", "tools"], "/");
const packages = directory("/workspace/packages", ["app"]);
const listDirectory = vi.fn<(path?: string) => Promise<FsListDirResult>>();
const onListing = vi.fn();
let browser: PlaceBrowserState;
const advance = (ms = PICKER_INPUT_DEBOUNCE_MS) => vi.advanceTimersByTimeAsync(ms);
function expectListing(draft: string, listing: FsListDirResult | null) {
  expect(browser).toMatchObject({ draft, loading: false });
  expect(browser.listing).toEqual(listing);
}

beforeEach(() => {
  vi.useFakeTimers();
  listDirectory.mockReset().mockResolvedValue(workspace);
  onListing.mockReset();
  browser = new PlaceBrowserState(listDirectory, vi.fn(), onListing);
});
afterEach(() => {
  browser.reset();
  try {
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

async function pendingSearch(phase = "in-flight") {
  await browser.navigate(workspace.path);
  const stale = createDeferred<FsListDirResult>();
  listDirectory.mockReturnValueOnce(stale.promise);
  browser.setDraft("/stale/a");
  if (phase === "in-flight") {
    await advance();
  }
  return stale;
}

describe("PlaceBrowserState", () => {
  it("coalesces directory edits, marks loading immediately, and preserves the raw draft", async () => {
    await browser.navigate(workspace.path);
    listDirectory.mockResolvedValue(packages);

    browser.setDraft("/workspace/to/");
    expect(browser.loading).toBe(true);
    expect(browser.view().empty).toBe("none");
    await advance(PICKER_INPUT_DEBOUNCE_MS - 1);
    browser.setDraft("  /workspace/packages/ap  ");
    await advance(PICKER_INPUT_DEBOUNCE_MS - 1);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    await advance(1);

    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith(packages.path);
    expectListing("  /workspace/packages/ap  ", packages);
    expect(onListing).toHaveBeenLastCalledWith(packages);
  });

  it("drops an old response while a newer directory is still debouncing", async () => {
    const stale = await pendingSearch();
    listDirectory.mockResolvedValueOnce(packages);

    browser.setDraft("/workspace/packages/ap");
    stale.resolve({ ...workspace, path: "/stale" });
    await advance(0);
    expect(browser.listing).toEqual(workspace);
    expect(browser.loading).toBe(true);
    expect(onListing).toHaveBeenCalledTimes(1);
    await advance();
    expectListing("/workspace/packages/ap", packages);
    expect(onListing).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["pending", false],
    ["in-flight", false],
    ["pending", true],
    ["in-flight", true],
  ] as const)("retires a %s directory search (reset=%s)", async (phase, reset) => {
    const stale = await pendingSearch(phase);
    if (reset) {
      browser.reset();
    } else {
      browser.setDraft("/workspace/to");
    }
    stale.resolve({ ...workspace, path: "/stale" });
    await advance();
    expect(listDirectory).toHaveBeenCalledTimes(phase === "pending" ? 1 : 2);
    expectListing(reset ? "" : "/workspace/to", reset ? null : workspace);
    if (reset) {
      expect(browser).toMatchObject({ error: null, activeIndex: -1 });
      expect(vi.getTimerCount()).toBe(0);
    } else {
      expect(browser.view().entries).toEqual([workspace.entries[1]]);
    }
    expect(browser.highlightedEntry()).toBeUndefined();
    expect(onListing).toHaveBeenCalledTimes(1);
  });

  it("explicit navigation supersedes a pending directory search", async () => {
    await browser.navigate(workspace.path);
    browser.setDraft("/stale/a");
    listDirectory.mockResolvedValue(packages);

    await browser.navigate(packages.path);
    await advance();
    expect(listDirectory.mock.calls).toEqual([[workspace.path], [packages.path]]);
    expect(browser.draft).toBe(packages.path);
    expect(browser.view().entries).toEqual(packages.entries);
  });

  it("keeps failed typed directories as soft no-match results", async () => {
    await browser.navigate(workspace.path);
    listDirectory.mockRejectedValueOnce(new Error("directory not found"));

    browser.setDraft("/missing/pa");
    await advance();
    expectListing("/missing/pa", workspace);
    expect(browser.error).toBeNull();
    expect(browser.view().empty).toBe("no-matches");
    expect(onListing).toHaveBeenCalledTimes(1);
  });

  it("retains an explicit missing scope without changing the requested path", async () => {
    listDirectory.mockRejectedValueOnce({
      details: {
        code: "MISSING_SCOPE",
        missingScope: "operator.read",
        requiredScopes: ["operator.read"],
      },
    });

    await browser.navigate("/missing");
    expect(listDirectory.mock.calls).toEqual([["/missing"]]);
    expect(browser).toMatchObject({ listing: null, draft: "/missing", loading: false });
    expect(browser.error).toBe(
      "To browse outside agent workspaces, open Inbox, select Limited access, request admin, then approve in Devices.",
    );
    expect(onListing).not.toHaveBeenCalled();
  });

  it("opens HOME for a missing starting folder but reports explicit navigation failures", async () => {
    const message = "Error: ENOTDIR: not a directory";

    const missingFolder = new GatewayRequestError({ code: "INVALID_REQUEST", message });
    listDirectory.mockRejectedValueOnce(missingFolder);
    await browser.navigate("/missing", "initial");
    expect(listDirectory.mock.calls).toEqual([["/missing"], [undefined]]);
    expect(browser).toMatchObject({ draft: workspace.path, error: null });
    listDirectory.mockRejectedValueOnce(missingFolder);
    browser.setDraft("/missing");
    await browser.activate();
    expect(browser).toMatchObject({ draft: "/missing", error: "Couldn't list that folder." });
  });

  it("wraps the highlight, completes with Tab, and opens the highlighted folder with Enter", async () => {
    const appOld = { name: "app-old", path: "/workspace/app-old" };
    const app = { name: "app", path: "/workspace/app" };
    listDirectory.mockResolvedValueOnce({ ...workspace, entries: [appOld, app] });
    await browser.navigate(workspace.path);
    expect(browser.highlightedEntry()).toBeUndefined();
    browser.moveHighlight(-1);
    expect(browser.highlightedEntry()).toEqual(app);
    browser.moveHighlight(1);
    expect(browser.highlightedEntry()).toEqual(appOld);
    browser.moveHighlight(1);
    browser.setDraft("/workspace/ap");
    expect(browser.highlightedEntry()).toBeUndefined();
    browser.moveHighlight(1);
    expect(browser.highlightedEntry()).toEqual(appOld);
    browser.moveHighlight(1);
    expect(browser.highlightedEntry()).toEqual(app);

    expect(browser.completeHighlighted()).toBe(true);
    expect(browser.draft).toBe(app.path);
    expect(browser.highlightedEntry()).toBeUndefined();
    expect(browser.completeHighlighted()).toBe(false);
    expect(browser.view().entries).toEqual([app, appOld]);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    listDirectory.mockResolvedValue(directory(app.path, []));
    await browser.activate();
    expect(listDirectory).toHaveBeenLastCalledWith(app.path);
    expect(browser.draft).toBe(app.path);
    expect(browser.view().entries).toEqual([]);
  });

  it.each(["  ", "relative"])("handles Enter on a non-absolute draft %j", async (draft) => {
    const relative = draft === "relative";
    if (relative) {
      await browser.navigate(workspace.path);
    }
    browser.setDraft(draft);
    browser.moveHighlight(1);
    if (relative) {
      expect(browser.highlightedEntry()).toEqual(workspace.entries[0]);
    } else {
      expect(browser.completeHighlighted()).toBe(false);
    }
    expect(browser.draft).toBe(draft);
    expect(browser.usablePath()).toBe(relative ? null : "");
    await browser.activate();
    await advance();
    expect(listDirectory.mock.calls).toEqual([[relative ? workspace.path : undefined]]);
    if (relative) {
      expect(browser.draft).toBe(draft);
      expect(browser.listing).toBe(workspace);
    }
  });
});
