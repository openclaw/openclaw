import { afterEach, expect, it, vi } from "vitest";
import { observeDocumentScroll } from "./document-scroll.ts";

afterEach(() => vi.restoreAllMocks());

it("shares capture delivery from descendant scrollers and releases the last listener", () => {
  const add = vi.spyOn(document, "addEventListener");
  const remove = vi.spyOn(document, "removeEventListener");
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = observeDocumentScroll(document, first);
  const stopSecond = observeDocumentScroll(document, second);
  try {
    expect(add.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
    expect(add.mock.calls.find(([type]) => type === "scroll")?.[2]).toBe(true);
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopFirst();
    scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(remove.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(0);
  } finally {
    stopFirst();
    stopSecond();
    scroller.remove();
  }
  expect(remove.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(1);
  const stopNext = observeDocumentScroll(document, first);
  stopNext();
  expect(add.mock.calls.filter(([type]) => type === "scroll")).toHaveLength(2);
});

it("keeps documents independent and skips a subscriber retired during delivery", () => {
  const other = document.implementation.createHTMLDocument();
  const otherListener = vi.fn();
  const retired = vi.fn();
  let stopRetired = () => {};
  const stopFirst = observeDocumentScroll(document, () => stopRetired());
  stopRetired = observeDocumentScroll(document, retired);
  const stopOther = observeDocumentScroll(other, otherListener);
  try {
    document.dispatchEvent(new Event("scroll"));
    expect(retired).not.toHaveBeenCalled();
    expect(otherListener).not.toHaveBeenCalled();
    other.dispatchEvent(new Event("scroll"));
    expect(otherListener).toHaveBeenCalledTimes(1);
  } finally {
    stopFirst();
    stopRetired();
    stopOther();
  }
});
