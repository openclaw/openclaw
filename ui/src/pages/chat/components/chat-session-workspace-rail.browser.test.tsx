import { createSignal, flush } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import "../../../styles.css";
import "../../../styles/chat.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

it.each([false, true])(
  "restores a loaded Files catalog after remount (search open: %s)",
  async (searchInitiallyOpen) => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(1200, 800);
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:0;top:0;width:440px;height:320px";
    document.body.append(container);
    onTestFinished(() => container.remove());
    let savedTop = 0;
    const [searchOpen, setSearchOpen] = createSignal(false);
    const [publication, setPublication] = createSignal(0);
    const workspace = (): SessionWorkspaceProps => {
      publication();
      return {
        sessionKey: "main",
        presentation: "desktop",
        loading: false,
        error: null,
        activeId: null,
        filter: "all",
        browserPath: "",
        browserSearch: "",
        navigation: {
          browserPath: "",
          browserSearch: "",
          filter: "all",
          expandedPaths: [""],
          searchOpen: searchOpen(),
          sessionExpanded: true,
          treeVisible: true,
          treeScroll: savedTop,
          sessionScroll: 0,
        },
        list: {
          sessionKey: "main",
          root: "/workspace",
          files: [],
          browser: {
            path: "",
            entries: Array.from({ length: 500 }, (_, index) => ({
              path: "file-" + String(index).padStart(2, "0") + ".ts",
              name: "file-" + String(index).padStart(2, "0") + ".ts",
              kind: "file",
            })),
          },
        },
        onBrowsePath: () => {},
        onRetry: () => {},
        onOpenFile: () => {},
        onSearch: () => {},
        onSearchOpenChange: setSearchOpen,
        onSetFilter: () => {},
        onOpenArtifact: () => {},
        onNavigationScroll: (area, top) => {
          if (area === "tree") {
            savedTop = top;
          }
        },
      };
    };
    const mount = () =>
      mountSolid(() => <SessionWorkspaceRail workspace={workspace()} />, { container });
    let view = mount();
    onTestFinished(() => view.unmount());
    const scroll = () =>
      container.querySelector<HTMLElement>(".workspace-desktop__project-scroll")!;
    await waitForSolid(() => expect(scroll().scrollHeight).toBeGreaterThan(scroll().clientHeight));
    scroll().scrollTop = 180;
    // A click can publish before the native scroll event records its offset.
    setPublication((value) => value + 1);
    flush();
    expect(scroll().scrollTop).toBe(180);
    await waitForSolid(() => expect(savedTop).toBe(180));
    view.unmount();
    setSearchOpen(searchInitiallyOpen);
    flush();
    view = mount();
    if (searchInitiallyOpen) {
      await userEvent.click(view.getByRole("button", { name: "Close file search" }));
    }
    await waitForSolid(() => expect(scroll().scrollHeight).toBeGreaterThan(scroll().clientHeight));
    expect(scroll().scrollTop).toBe(180);
  },
);

it.each(["open", "threshold"])(
  "keeps the shared scroll position when a lower folder attaches (%s)",
  async (attachment) => {
    const { page, userEvent } = await import("vitest/browser");
    await page.viewport(1200, 800);
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:0;top:0;width:440px;height:320px";
    document.body.append(container);
    onTestFinished(() => container.remove());
    const opening = attachment !== "threshold";
    const prefixes = ["a-prefix"];
    const [count, setCount] = createSignal(opening ? 250 : 99);
    const [expandedPaths, setExpandedPaths] = createSignal([
      "",
      ...prefixes,
      ...(opening ? [] : ["z-target"]),
    ]);
    let savedTop = 0;
    const filename = (path: string, index: number) =>
      `${path ? `${path}/` : ""}file-${String(index).padStart(3, "0")}.ts`;
    const browser = (path: string, length: number) => ({
      path,
      entries: Array.from({ length }, (_, index) => ({
        path: filename(path, index),
        name: filename(path, index).split("/").at(-1)!,
        kind: "file" as const,
      })),
    });
    const workspace = (): SessionWorkspaceProps => ({
      sessionKey: "main",
      presentation: "desktop",
      loading: false,
      error: null,
      activeId: null,
      filter: "all",
      browserPath: "",
      browserSearch: "",
      navigation: {
        browserPath: "",
        browserSearch: "",
        filter: "all",
        expandedPaths: expandedPaths(),
        searchOpen: false,
        sessionExpanded: true,
        treeVisible: true,
        treeScroll: savedTop,
        sessionScroll: 0,
      },
      list: {
        sessionKey: "main",
        root: "/workspace",
        files: [],
        browser: {
          path: "",
          entries: [
            ...prefixes.map((path) => ({ path, name: path, kind: "directory" as const })),
            { path: "z-target", name: "z-target", kind: "directory" },
            ...browser("", 20).entries,
          ],
        },
      },
      directories: {
        ...Object.fromEntries(
          prefixes.map((path) => [
            path,
            { loading: false, error: null, browser: browser(path, 250) },
          ]),
        ),
        "z-target": { loading: false, error: null, browser: browser("z-target", count()) },
      },
      onBrowsePath: () => {},
      onRetry: () => {},
      onOpenFile: () => {},
      onSearch: () => {},
      onSetFilter: () => {},
      onOpenArtifact: () => {},
      onToggleDirectory: (path) => setExpandedPaths((paths) => [...paths, path]),
      onNavigationScroll: (area, top) => {
        if (area === "tree") {
          savedTop = top;
        }
      },
    });
    const view = mountSolid(() => <SessionWorkspaceRail workspace={workspace()} />, { container });
    onTestFinished(() => view.unmount());
    const button = (path: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${path}"]`)!;
    await waitForSolid(() =>
      expect(container.querySelector(".workspace-desktop__project-scroll")).not.toBeNull(),
    );
    const scroll = container.querySelector<HTMLElement>(".workspace-desktop__project-scroll")!;
    const frames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    await document.fonts.ready;
    await waitForSolid(() => expect(scroll.scrollHeight).toBeGreaterThan(250 * 28));
    await frames();
    const target = button("z-target");
    scroll.scrollTop +=
      target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24;
    await waitForSolid(() => {
      expect(scroll.scrollTop).toBeGreaterThan(500);
      expect(savedTop).toBe(scroll.scrollTop);
    });
    const focused = opening ? target : button(filename("z-target", 0));
    focused.focus({ preventScroll: true });
    await frames();
    const top = scroll.scrollTop;
    const headerTop = target.getBoundingClientRect().top;
    if (opening) {
      await userEvent.keyboard("{Enter}");
    } else {
      setCount(100);
    }
    await waitForSolid(() => {
      const files = container.querySelectorAll('button[aria-label^="z-target/file-"]');
      expect(files.length).toBeGreaterThan(2);
      expect(files.length).toBeLessThan(80);
      expect(target.getAttribute("aria-expanded")).toBe("true");
    });
    await frames();
    await Promise.all(
      container.getAnimations({ subtree: true }).map((animation) => animation.finished),
    );
    expect(scroll.scrollTop).toBe(top);
    expect(target.getBoundingClientRect().top).toBeCloseTo(headerTop, 0);
    expect(document.activeElement).toBe(focused);
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(button(filename("z-target", opening ? 0 : 1)));
  },
);

it("keeps native file navigation and selection while windowing a large leaf folder", async () => {
  const { page, userEvent } = await import("vitest/browser");
  await page.viewport(1200, 800);
  const container = document.createElement("div");
  container.id = "workspace-leaf-window-proof";
  container.style.cssText = "position:fixed;left:0;top:0;width:440px;height:320px";
  document.body.append(container);
  onTestFinished(() => container.remove());
  const opened: string[] = [];
  const filename = (index: number) => "docs/file-" + String(index).padStart(4, "0") + ".ts";
  const [revision, setRevision] = createSignal(0);
  const [fileCount, setFileCount] = createSignal(500);
  const [fileOffset, setFileOffset] = createSignal(0);
  const [filter, setFilter] = createSignal<SessionWorkspaceProps["filter"]>("all");
  const [nestedFolder, setNestedFolder] = createSignal(false);
  const [expandedPaths, setExpandedPaths] = createSignal(["", "docs"]);
  const [searchOpen, setSearchOpen] = createSignal(false);
  let savedTop = 0;
  const workspace = (): SessionWorkspaceProps => {
    revision();
    return {
      sessionKey: "main",
      presentation: "desktop",
      loading: false,
      error: null,
      activeId: "file:" + filename(300),
      filter: filter(),
      browserPath: "",
      browserSearch: "",
      navigation: {
        browserPath: "",
        browserSearch: "",
        filter: filter(),
        expandedPaths: expandedPaths(),
        searchOpen: searchOpen(),
        sessionExpanded: true,
        treeVisible: true,
        treeScroll: savedTop,
        sessionScroll: 0,
      },
      list: {
        sessionKey: "main",
        root: "/workspace",
        files: [],
        browser: {
          path: "",
          entries: [
            { path: "docs", name: "docs", kind: "directory" },
            { path: "tail.ts", name: "tail.ts", kind: "file" },
            ...Array.from({ length: 220 }, (_, index) => ({
              path: `z-mixed-${index}.ts`,
              name: `z-mixed-${index}.ts`,
              kind: "file" as const,
            })),
          ],
        },
      },
      directories: {
        docs: {
          loading: false,
          error: null,
          browser: {
            path: "docs",
            entries: [
              ...Array.from({ length: fileCount() }, (_, index) => ({
                path: filename(index + fileOffset()),
                name: filename(index + fileOffset())
                  .split("/")
                  .at(-1)!,
                kind: "file" as const,
                sessionKind: index % 2 === 0 ? ("modified" as const) : ("read" as const),
              })),
              ...(nestedFolder()
                ? [{ path: "docs/nested", name: "nested", kind: "directory" as const }]
                : []),
            ],
          },
        },
      },
      onBrowsePath: () => {},
      onRetry: () => {},
      onOpenFile: (path) => opened.push(path),
      onSearch: () => {},
      onSearchOpenChange: setSearchOpen,
      onSetFilter: setFilter,
      onOpenArtifact: () => {},
      onToggleDirectory: (path) =>
        setExpandedPaths((paths) =>
          paths.includes(path) ? paths.filter((entry) => entry !== path) : [...paths, path],
        ),
      onNavigationScroll: (area, top) => {
        if (area === "tree") {
          savedTop = top;
        }
      },
    };
  };
  const view = mountSolid(() => <SessionWorkspaceRail workspace={workspace()} />, { container });
  onTestFinished(() => view.unmount());
  const button = (path: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="${path}"]`);
  const scroll = () => container.querySelector<HTMLElement>(".workspace-desktop__project-scroll")!;
  const mountedFiles = () =>
    container.querySelectorAll<HTMLButtonElement>('button[aria-label^="docs/file-"]');
  await waitForSolid(() => {
    expect(mountedFiles().length).toBeGreaterThan(2);
    expect(mountedFiles().length).toBeLessThan(80);
    expect(button(filename(3))).not.toBeNull();
    expect(scroll().scrollHeight).toBeGreaterThan(500 * 28);
    expect(button(filename(300))?.getAttribute("aria-current")).toBe("true");
    expect(container.querySelectorAll('button[aria-label^="z-mixed-"]')).toHaveLength(220);
  });
  const selected = button(filename(300))!;
  expect(selected.parentElement?.getAttribute("aria-posinset")).toBe("301");
  expect(selected.parentElement?.getAttribute("aria-setsize")).toBe("500");

  // Cross the visible window's end with ordinary Tab, not a tree keyboard shim.
  const boundary = [...mountedFiles()]
    .map((node) => Number(node.getAttribute("aria-label")?.match(/file-(\d+)/)?.[1]))
    .filter((index) => index < 100)
    .toSorted((a, b) => b - a)[0]!;
  button(filename(boundary))!.focus();
  await waitForSolid(() => expect(button(filename(boundary + 1))).not.toBeNull());
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(button(filename(boundary + 1)));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(button(filename(boundary)));
  const focused = document.activeElement;
  setRevision((value) => value + 1);
  await waitForSolid(() => {
    expect(document.activeElement).toBe(focused);
    expect(button(filename(300))).toBe(selected);
  });

  button(filename(499))!.focus();
  await waitForSolid(() => expect(document.activeElement).toBe(button(filename(499))));
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(button("tail.ts"));
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
  expect(document.activeElement).toBe(button(filename(499)));
  await userEvent.keyboard("{Enter}");
  expect(opened.at(-1)).toBe(filename(499));

  // Search parks the same tree; its scroll owner and pinned selection survive.
  scroll().scrollTop = 4000;
  await waitForSolid(() => expect(savedTop).toBe(4000));
  const frames = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  await frames();
  const viewport = scroll().getBoundingClientRect();
  const visibleBeforeSearch = [...mountedFiles()].find((node) => {
    const rect = node.getBoundingClientRect();
    return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
  })!;
  expect(visibleBeforeSearch).toBeDefined();
  const visiblePath = visibleBeforeSearch.getAttribute("aria-label")!;
  setSearchOpen(true);
  await waitForSolid(() => expect(scroll().offsetHeight).toBe(0));
  // Let both the native ResizeObserver and virtual-core's following frame run.
  await frames();
  await frames();
  setSearchOpen(false);
  flush();
  expect(button(visiblePath)).toBe(visibleBeforeSearch);
  expect(button(filename(300))).toBe(selected);
  await frames();
  await waitForSolid(() => {
    expect(scroll().scrollTop).toBe(4000);
    expect(button(filename(300))).toBe(selected);
  });

  // The same keyed button survives both sides of the eager/windowed boundary.
  button(filename(0))!.focus();
  const retained = button(filename(0));
  setFileCount(99);
  await waitForSolid(() => {
    expect(mountedFiles()).toHaveLength(99);
    expect(document.activeElement).toBe(retained);
  });
  setFileCount(100);
  await waitForSolid(() => {
    expect(retained?.parentElement?.getAttribute("aria-setsize")).toBe("100");
    expect(document.activeElement).toBe(retained);
    expect(mountedFiles().length).toBeLessThan(80);
  });
  setFileCount(99);
  await waitForSolid(() => {
    expect(mountedFiles()).toHaveLength(99);
    expect(document.activeElement).toBe(retained);
  });

  // The realistic Changed filter keeps 125 of 250 files without remounting focus.
  setFileCount(250);
  await waitForSolid(() => {
    expect(retained?.parentElement?.getAttribute("aria-setsize")).toBe("250");
    expect(document.activeElement).toBe(retained);
    expect(mountedFiles().length).toBeLessThan(80);
  });
  setFilter("changed");
  await waitForSolid(() => {
    expect(retained?.parentElement?.getAttribute("aria-setsize")).toBe("125");
    expect(document.activeElement).toBe(retained);
    expect(mountedFiles().length).toBeLessThan(80);
    expect(button(filename(1))).toBeNull();
  });
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(button(filename(2)));
  button(filename(0))!.focus();
  setFilter("all");
  setNestedFolder(true);
  await waitForSolid(() => {
    expect(button("docs/nested")?.getAttribute("aria-expanded")).toBe("false");
    expect(mountedFiles()).toHaveLength(250);
    expect(button(filename(0))).toBe(retained);
  });
  // Mixed insertion also blurs the retained button in the eager base renderer.
  retained!.focus();
  setNestedFolder(false);
  await waitForSolid(() => {
    expect(button("docs/nested")).toBeNull();
    expect(mountedFiles().length).toBeLessThan(80);
    expect(document.activeElement).toBe(retained);
  });

  button("docs")!.focus();
  await userEvent.keyboard("{Enter}");
  await waitForSolid(() => expect(button(filename(0))).toBeNull());
  await userEvent.keyboard("{Enter}");
  await waitForSolid(() => expect(button(filename(0))).not.toBeNull());
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).toBe(button(filename(0)));

  // Row height is measured, so a larger font must not overlap the next file.
  const style = document.createElement("style");
  style.textContent = "#workspace-leaf-window-proof .workspace-desktop__row { line-height: 40px; }";
  container.append(style);
  await waitForSolid(() => {
    const first = button(filename(0))!.getBoundingClientRect();
    const second = button(filename(1))!.getBoundingClientRect();
    expect(first.height).toBeGreaterThan(40);
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  });

  // A same-size replacement must invalidate the old key-to-position mapping.
  style.remove();
  setFileOffset(500);
  await waitForSolid(() => expect(button(filename(0))).toBeNull());
  scroll().scrollTop = 50 * 28;
  await waitForSolid(() => {
    expect(button(filename(550))).not.toBeNull();
  });
});
