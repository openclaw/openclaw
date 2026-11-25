import { expect, it, onTestFinished, vi } from "vitest";
import { registerChatSearchTextBlock, watchChatSearchHighlight } from "./chat-search-highlight.ts";
import { publishTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { TranscriptSearchState } from "./chat-transcript-search-state.ts";

const CHAT_SEARCH_HIGHLIGHT = "openclaw-chat-search";

function watchSearch(root: HTMLElement): TranscriptSearchState {
  const search = new TranscriptSearchState();
  onTestFinished(watchChatSearchHighlight(root, search));
  search.toggle();
  return search;
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

it("updates changed text without replacing other blocks or panes and retires closed searches", async () => {
  const first = document.body.appendChild(document.createElement("section"));
  const second = document.body.appendChild(document.createElement("section"));
  const firstSearch = watchSearch(first);
  const secondSearch = watchSearch(second);
  const releases: (() => void)[] = [];
  const text = (root: Element, value: string) => {
    const block = root.appendChild(document.createElement("div"));
    block.className = "chat-text";
    block.textContent = value;
    releases.push(registerChatSearchTextBlock(block));
    return block;
  };
  const growing = text(first, "Needle one");
  const stable = text(first, "Needle two");
  const sibling = text(second, "Needle three");
  onTestFinished(() => {
    firstSearch.close();
    secondSearch.close();
    releases.forEach((release) => release());
    first.remove();
    second.remove();
    vi.restoreAllMocks();
  });
  const ranges = () => Array.from(CSS.highlights.get(CHAT_SEARCH_HIGHLIGHT) ?? []);
  const inBlock = (block: Element) =>
    ranges().filter((range) => block.contains(range.startContainer));
  firstSearch.setQuery("needle");
  secondSearch.setQuery("needle");
  await nextFrame();
  expect(ranges().map((range) => (range instanceof Range ? range.toString() : null))).toEqual([
    "Needle",
    "Needle",
    "Needle",
  ]);
  const registryEntry = CSS.highlights.get(CHAT_SEARCH_HIGHLIGHT);
  const stableRange = inBlock(stable)[0];
  const siblingRange = inBlock(sibling)[0];

  growing.firstChild!.textContent += " needle";
  await Promise.resolve();
  await nextFrame();
  expect(
    inBlock(growing).map((range) => (range instanceof Range ? range.toString() : null)),
  ).toEqual(["Needle", "needle"]);
  expect(inBlock(stable)[0]).toBe(stableRange);
  expect(inBlock(sibling)[0]).toBe(siblingRange);
  expect(CSS.highlights.get(CHAT_SEARCH_HIGHLIGHT)).toBe(registryEntry);

  const added = text(first, "Needle from older history");
  await Promise.resolve();
  await nextFrame();
  expect(inBlock(added).map((range) => (range instanceof Range ? range.toString() : null))).toEqual(
    ["Needle"],
  );
  added.remove();
  await Promise.resolve();
  await nextFrame();
  expect(inBlock(added)).toEqual([]);

  firstSearch.close();
  expect(ranges()).toEqual([siblingRange]);
  secondSearch.close();
  expect(CSS.highlights.has(CHAT_SEARCH_HIGHLIGHT)).toBe(false);
});

it("cancels a queued text refresh when a query changes and search closes before the frame", async () => {
  const root = document.body.appendChild(document.createElement("section"));
  const search = watchSearch(root);
  const block = root.appendChild(document.createElement("div"));
  block.className = "chat-text";
  block.textContent = "Needle";
  const release = registerChatSearchTextBlock(block);
  onTestFinished(() => {
    search.close();
    release();
    root.remove();
    vi.restoreAllMocks();
  });
  search.setQuery("needle");
  await nextFrame();
  block.firstChild!.textContent += " changed";
  await Promise.resolve();
  search.setQuery("changed");
  search.close();
  const read = vi.spyOn(document, "createTreeWalker");
  const range = vi.spyOn(document, "createRange");
  await nextFrame();
  expect(read).not.toHaveBeenCalled();
  expect(range).not.toHaveBeenCalled();
  expect(CSS.highlights.has(CHAT_SEARCH_HIGHLIGHT)).toBe(false);
});

it("materializes matches as their text enters the viewport without searching it again", async () => {
  const root = document.body.appendChild(document.createElement("section"));
  root.style.cssText = "position:fixed;top:0;left:0;width:300px;height:40px;overflow:auto";
  const search = watchSearch(root);
  const first = root.appendChild(document.createElement("div"));
  first.className = "chat-text";
  first.textContent = "Needle at the beginning";
  const last = root.appendChild(document.createElement("div"));
  last.className = "chat-text";
  last.style.marginTop = "200px";
  last.textContent = "Needle at the end";
  const releaseFirst = registerChatSearchTextBlock(first);
  const releaseLast = registerChatSearchTextBlock(last);
  onTestFinished(() => {
    search.close();
    releaseFirst();
    releaseLast();
    root.remove();
    vi.restoreAllMocks();
  });
  const highlightedNodes = () =>
    Array.from(CSS.highlights.get(CHAT_SEARCH_HIGHLIGHT) ?? [], (range) => range.startContainer);
  search.setQuery("needle");
  await nextFrame();
  expect(highlightedNodes()).toEqual([first.firstChild]);
  const read = vi.spyOn(document, "createTreeWalker");
  root.scrollTop = root.scrollHeight;
  publishTranscriptScroll(root, {
    type: "offset",
    delta: root.scrollTop,
    scrolling: false,
    touching: false,
    programmatic: true,
  });
  await nextFrame();
  expect(highlightedNodes()).toEqual([last.firstChild]);
  expect(read).not.toHaveBeenCalled();
  search.close();
  const geometry = vi.spyOn(Range.prototype, "getBoundingClientRect");
  root.scrollTop = 0;
  publishTranscriptScroll(root, {
    type: "offset",
    delta: -200,
    scrolling: false,
    touching: false,
    programmatic: true,
  });
  document.fonts.dispatchEvent(new Event("loadingdone"));
  last.style.marginTop = "100px";
  await nextFrame();
  expect(geometry).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(highlightedNodes()).toEqual([]);
});
