import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsListDirResult } from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { PlaceBrowserState, PICKER_INPUT_DEBOUNCE_MS } from "./place-browser-state.ts";

const workspace = {
  path: "/workspace",
  parent: "/",
  home: "/home/test",
  entries: [
    { name: "packages", path: "/workspace/packages" },
    { name: "tools", path: "/workspace/tools" },
  ],
} satisfies FsListDirResult;
const packages = {
  path: "/workspace/packages",
  parent: "/workspace",
  home: "/home/test",
  entries: [{ name: "app", path: "/workspace/packages/app" }],
} satisfies FsListDirResult;
const states: PlaceBrowserState[] = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const state of states.splice(0)) {
    state.reset();
  }
  try {
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

function fixture() {
  const listDirectory = vi.fn<(path?: string) => Promise<FsListDirResult>>();
  listDirectory.mockResolvedValue(workspace);
  const onListing = vi.fn();
  const browser = new PlaceBrowserState(listDirectory, vi.fn(), onListing);
  states.push(browser);
  return { browser, listDirectory, onListing };
}

describe("PlaceBrowserState", () => {
  it("filters the loaded directory without another request", async () => {
    const { browser, listDirectory } = fixture();
    await browser.navigate(workspace.path);

    browser.setDraft("  /workspace/pa  ");
    expect(browser.draft).toBe("  /workspace/pa  ");
    expect(browser.usablePath()).toBe("/workspace/pa");
    expect(browser.loading).toBe(false);
    expect(browser.view().entries).toEqual([workspace.entries[0]]);
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(listDirectory).toHaveBeenCalledTimes(1);
  });

  it("coalesces directory edits, marks loading immediately, and preserves the raw draft", async () => {
    const { browser, listDirectory, onListing } = fixture();
    await browser.navigate(workspace.path);
    listDirectory.mockResolvedValue(packages);

    browser.setDraft("/workspace/to/");
    expect(browser.loading).toBe(true);
    expect(browser.view().empty).toBe("none");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS - 1);
    browser.setDraft("  /workspace/packages/ap  ");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS - 1);
    expect(listDirectory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(listDirectory).toHaveBeenLastCalledWith(packages.path);
    expect(browser.draft).toBe("  /workspace/packages/ap  ");
    expect(browser.listing).toEqual(packages);
    expect(browser.loading).toBe(false);
    expect(onListing).toHaveBeenLastCalledWith(packages);
  });

  it("drops an old response while a newer directory is still debouncing", async () => {
    const { browser, listDirectory, onListing } = fixture();
    await browser.navigate(workspace.path);
    const stale = createDeferred<FsListDirResult>();
    listDirectory.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(packages);
    browser.setDraft("/stale/a");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);

    browser.setDraft("/workspace/packages/ap");
    stale.resolve({ ...workspace, path: "/stale" });
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.listing).toEqual(workspace);
    expect(browser.loading).toBe(true);
    expect(onListing).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.listing).toEqual(packages);
    expect(browser.draft).toBe("/workspace/packages/ap");
    expect(onListing).toHaveBeenCalledTimes(2);
  });

  it.each(["pending", "in-flight"])(
    "cancels a %s directory search when returning to the loaded directory",
    async (phase) => {
      const { browser, listDirectory, onListing } = fixture();
      await browser.navigate(workspace.path);
      const stale = createDeferred<FsListDirResult>();
      listDirectory.mockReturnValueOnce(stale.promise);
      browser.setDraft("/stale/a");
      if (phase === "in-flight") {
        await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      }

      browser.setDraft("/workspace/to");
      stale.resolve({ ...workspace, path: "/stale" });
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      expect(listDirectory).toHaveBeenCalledTimes(phase === "pending" ? 1 : 2);
      expect(browser.listing).toEqual(workspace);
      expect(browser.loading).toBe(false);
      expect(browser.view().entries).toEqual([workspace.entries[1]]);
      expect(browser.highlightedEntry()).toBeUndefined();
      expect(onListing).toHaveBeenCalledTimes(1);
    },
  );

  it("explicit navigation supersedes a pending directory search", async () => {
    const { browser, listDirectory } = fixture();
    await browser.navigate(workspace.path);
    browser.setDraft("/stale/a");
    listDirectory.mockResolvedValue(packages);

    await browser.navigate(packages.path);
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(listDirectory.mock.calls).toEqual([[workspace.path], [packages.path]]);
    expect(browser.draft).toBe(packages.path);
    expect(browser.view().entries).toEqual(packages.entries);
  });

  it("keeps failed typed directories as soft no-match results", async () => {
    const { browser, listDirectory, onListing } = fixture();
    await browser.navigate(workspace.path);
    listDirectory.mockRejectedValueOnce(new Error("directory not found"));

    browser.setDraft("/missing/pa");
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(browser.listing).toEqual(workspace);
    expect(browser.draft).toBe("/missing/pa");
    expect(browser.error).toBeNull();
    expect(browser.loading).toBe(false);
    expect(browser.view().empty).toBe("no-matches");
    expect(onListing).toHaveBeenCalledTimes(1);
  });

  it("keeps the current listing after explicit navigation fails", async () => {
    const { browser, listDirectory } = fixture();
    await browser.navigate(workspace.path);
    listDirectory.mockRejectedValueOnce(new Error("directory not found"));

    await browser.navigate("/missing");
    expect(listDirectory).toHaveBeenCalledTimes(2);
    expect(browser.listing).toEqual(workspace);
    expect(browser.draft).toBe("/missing");
    expect(browser.error).toBe("Couldn't list that folder.");
    expect(browser.loading).toBe(false);
    browser.setDraft("/workspace/pa");
    expect(browser.error).toBeNull();
  });

  it.each([
    {
      label: "load failure",
      error: new Error("directory not found"),
      message: "Couldn't list that folder.",
    },
    {
      label: "missing scope",
      error: {
        code: "FORBIDDEN",
        message: "permission denied",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.read",
          requiredScopes: ["operator.read"],
        },
      },
      message:
        "To browse outside agent workspaces, open Inbox, select Limited access, request admin, then approve in Devices.",
    },
  ])(
    "retains an explicit $label without changing the requested path",
    async ({ error, message }) => {
      const { browser, listDirectory, onListing } = fixture();
      listDirectory.mockRejectedValueOnce(error);

      await browser.navigate("/missing");
      expect(listDirectory.mock.calls).toEqual([["/missing"]]);
      expect(browser.listing).toBeNull();
      expect(browser.draft).toBe("/missing");
      expect(browser.error).toBe(message);
      expect(browser.loading).toBe(false);
      expect(onListing).not.toHaveBeenCalled();
    },
  );

  it("settles when the fallback root also fails", async () => {
    const { browser, listDirectory } = fixture();
    listDirectory
      .mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message: "ENOENT: missing workspace" }),
      )
      .mockRejectedValue(new Error("unavailable"));

    await browser.navigate("/missing", "initial");
    expect(listDirectory.mock.calls).toEqual([["/missing"], [undefined]]);
    expect(browser.listing).toBeNull();
    expect(browser.error).toBe("Couldn't list that folder.");
    expect(browser.loading).toBe(false);
  });

  it("shows the loaded folder's children for its own path and filters child names without loading", async () => {
    const { browser, listDirectory } = fixture();
    await browser.navigate(workspace.path);
    expect(browser.draft).toBe(workspace.path);
    expect(browser.view().entries).toEqual(workspace.entries);

    for (const [draft, expectedEntries] of [
      [workspace.path, workspace.entries],
      [packages.path, [workspace.entries[0]]],
      [workspace.path, workspace.entries],
    ] as const) {
      browser.setDraft(draft);
      expect(browser.loading).toBe(false);
      expect(browser.view().entries).toEqual(expectedEntries);
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      expect(listDirectory).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["loaded path", "trailing separator", "edited highlight"])(
    "opens exactly the typed directory on Enter (%s)",
    async (input) => {
      const { browser, listDirectory } = fixture();
      await browser.navigate(workspace.path);
      if (input === "edited highlight") {
        browser.moveHighlight(1);
      }
      browser.setDraft(input === "trailing separator" ? "/workspace/" : workspace.path);
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      await browser.activate();
      expect(listDirectory).toHaveBeenLastCalledWith(
        input === "trailing separator" ? "/workspace/" : workspace.path,
      );
      expect(browser.draft).toBe(workspace.path);
      expect(browser.highlightedEntry()).toBeUndefined();
    },
  );

  it.each(["ENOENT: missing workspace", "Error: ENOTDIR: not a directory"])(
    "opens HOME without an error for a missing starting folder (%s)",
    async (message) => {
      const { browser, listDirectory } = fixture();
      listDirectory.mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message }),
      );
      await browser.navigate("/missing", "initial");
      expect(listDirectory.mock.calls).toEqual([["/missing"], [undefined]]);
      expect(browser.draft).toBe(workspace.path);
      expect(browser.error).toBeNull();
      listDirectory.mockRejectedValueOnce(
        new GatewayRequestError({ code: "INVALID_REQUEST", message }),
      );
      browser.setDraft("/missing");
      await browser.activate();
      expect(browser.draft).toBe("/missing");
      expect(browser.error).toBe("Couldn't list that folder.");
    },
  );

  it("does not recover a starting folder's permission error as a missing folder", async () => {
    const { browser, listDirectory } = fixture();
    listDirectory.mockRejectedValueOnce(
      new GatewayRequestError({ code: "INVALID_REQUEST", message: "EACCES: permission denied" }),
    );
    await browser.navigate("/restricted", "initial");
    expect(listDirectory.mock.calls).toEqual([["/restricted"]]);
    expect(browser.draft).toBe("/restricted");
    expect(browser.error).toBe("Couldn't list that folder.");
  });

  it("wraps the highlight, completes with Tab, and opens the highlighted folder with Enter", async () => {
    const { browser, listDirectory } = fixture();
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
    listDirectory.mockResolvedValue({
      ...workspace,
      path: app.path,
      parent: workspace.path,
      entries: [],
    });
    await browser.activate();
    expect(listDirectory).toHaveBeenLastCalledWith(app.path);
    expect(browser.draft).toBe(app.path);
    expect(browser.view().entries).toEqual([]);
  });

  it.each([
    { draft: "  /missing  ", usable: "/missing", requested: "/missing" },
    { draft: "  ", usable: "", requested: undefined },
    { draft: "relative", usable: null, requested: null },
  ])(
    "uses the typed path when Enter has no highlight: $draft",
    async ({ draft, usable, requested }) => {
      const { browser, listDirectory } = fixture();
      browser.setDraft(draft);
      browser.moveHighlight(1);
      expect(browser.completeHighlighted()).toBe(false);
      expect(browser.draft).toBe(draft);
      expect(browser.usablePath()).toBe(usable);
      await browser.activate();
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      expect(listDirectory.mock.calls).toEqual(requested === null ? [] : [[requested]]);
    },
  );

  it.each(["relative", "C:packages"])(
    "keeps a relative draft on Enter despite a highlighted folder: %j",
    async (draft) => {
      const { browser, listDirectory } = fixture();
      await browser.navigate(workspace.path);
      browser.setDraft(draft);
      browser.moveHighlight(1);
      expect(browser.highlightedEntry()).toEqual(workspace.entries[0]);
      expect(browser.usablePath()).toBeNull();

      await browser.activate();
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
      expect(listDirectory).toHaveBeenCalledTimes(1);
      expect(browser.draft).toBe(draft);
      expect(browser.listing).toBe(workspace);
    },
  );

  it.each(["pending", "in-flight"])("reset retires %s directory work", async (phase) => {
    const { browser, listDirectory, onListing } = fixture();
    await browser.navigate(workspace.path);
    const stale = createDeferred<FsListDirResult>();
    listDirectory.mockReturnValueOnce(stale.promise);
    browser.setDraft("/stale/a");
    if (phase === "in-flight") {
      await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    }

    browser.reset();
    stale.resolve({ ...workspace, path: "/stale" });
    await vi.advanceTimersByTimeAsync(PICKER_INPUT_DEBOUNCE_MS);
    expect(listDirectory).toHaveBeenCalledTimes(phase === "pending" ? 1 : 2);
    expect(browser.listing).toBeNull();
    expect(browser.draft).toBe("");
    expect(browser.loading).toBe(false);
    expect(browser.error).toBeNull();
    expect(browser.highlightedEntry()).toBeUndefined();
    expect(browser.activeIndex).toBe(-1);
    expect(onListing).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
