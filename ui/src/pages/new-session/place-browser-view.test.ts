import { describe, expect, it } from "vitest";
import type {
  FsDirEntry,
  FsListDirResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { resolvePlaceBrowserView } from "./place-browser-view.ts";

describe("filterBrowserEntries", () => {
  const entries = [
    { name: "App", path: "/workspace/App" },
    { name: "app-old", path: "/workspace/app-old" },
    { name: "app", path: "/workspace/app" },
    { name: "old-packages", path: "/workspace/old-packages" },
    { name: "Packages", path: "/workspace/Packages" },
    { name: "tools", path: "/workspace/tools" },
    { name: "package-tools", path: "/workspace/package-tools" },
    { name: "my-packages", path: "/workspace/my-packages" },
    { name: ".packages", path: "/workspace/.packages", hidden: true },
  ] satisfies FsDirEntry[];

  const filteredEntries = (prefix: string) =>
    resolvePlaceBrowserView({
      listing: { path: "/workspace", home: "/", entries },
      draft: `/workspace/${prefix}`,
      loading: false,
    }).entries;

  it.each([
    ["PA", ["Packages", "package-tools", "old-packages", "my-packages"]],
    ["app", ["app", "App", "app-old"]],
  ])("ranks spelled, exact, prefix, then substring matches for %s", (prefix, expectedNames) => {
    expect(filteredEntries(prefix).map((entry) => entry.name)).toEqual(expectedNames);
  });
});

describe("resolvePlaceBrowserView", () => {
  const entries = [{ name: "packages", path: "/workspace/packages" }];
  const listing = { path: "/workspace", home: "/home/user", entries } satisfies FsListDirResult;

  it.each([["unmatched prefix", listing, "/workspace/zzz", false, [], "no-matches"]])(
    "resolves %s",
    (_name, currentListing, draft, loading, expectedEntries, empty) => {
      expect(resolvePlaceBrowserView({ listing: currentListing, draft, loading })).toEqual({
        entries: expectedEntries,
        empty,
      });
    },
  );

  it("matches Windows directory spellings before filtering", () => {
    const windowsListing = { path: "C:\\Workspace\\", home: "C:\\", entries };
    expect(
      resolvePlaceBrowserView({
        listing: windowsListing,
        draft: "c:/workspace/pa",
        loading: false,
      }),
    ).toEqual({
      entries,
      empty: "none",
    });
  });
});
