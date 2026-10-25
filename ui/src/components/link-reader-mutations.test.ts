/* @vitest-environment jsdom */
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { observeLinkReaderInline } from "./link-reader-mutations.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shares provider observation and preserves retained records during a removal batch", async () => {
  const NativeMutationObserver = MutationObserver;
  const created: MutationObserver[] = [];
  vi.stubGlobal(
    "MutationObserver",
    class extends NativeMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        created.push(this);
      }
    },
  );
  const hosts = Array.from({ length: 100 }, () =>
    document.body.appendChild(document.createElement("section")),
  );
  const notify = hosts.map(() => vi.fn());
  const stops = hosts.map((host, index) => observeLinkReaderInline(host, notify[index]!));
  onTestFinished(() => stops.forEach((stop) => stop()));
  expect(created).toHaveLength(1);
  const observe = vi.spyOn(created[0]!, "observe");
  const disconnect = vi.spyOn(created[0]!, "disconnect");
  const link = hosts[99]!.appendChild(document.createElement("a"));
  await Promise.resolve();
  notify[99]!.mockClear();
  stops.slice(0, 99).forEach((stop) => stop());
  link.href = "https://example.test/current";
  await Promise.resolve();
  expect(notify[99]).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledExactlyOnceWith(hosts[99], {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["href"],
  });
  expect(disconnect).toHaveBeenCalledOnce();
  stops[99]!();
  expect(disconnect).toHaveBeenCalledTimes(2);
  link.href = "https://example.test/retired";
  await Promise.resolve();
  expect(notify[99]).toHaveBeenCalledOnce();
});

it("routes nested and shadow-island changes without observing unrelated attributes", async () => {
  const outer = document.body.appendChild(document.createElement("section"));
  const inner = outer.appendChild(document.createElement("section"));
  const shadow = outer.appendChild(document.createElement("div")).attachShadow({ mode: "open" });
  const shadowHost = shadow.appendChild(document.createElement("section"));
  const changedOuter = vi.fn();
  const changedInner = vi.fn();
  const changedShadow = vi.fn();
  onTestFinished(observeLinkReaderInline(outer, changedOuter));
  onTestFinished(observeLinkReaderInline(inner, changedInner));
  onTestFinished(observeLinkReaderInline(shadowHost, changedShadow));
  inner.append(document.createElement("a"));
  shadowHost.append(document.createElement("a"));
  await Promise.resolve();
  expect(changedOuter).toHaveBeenCalledOnce();
  expect(changedInner).toHaveBeenCalledOnce();
  expect(changedShadow).toHaveBeenCalledOnce();
  changedOuter.mockClear();
  changedInner.mockClear();
  changedShadow.mockClear();
  inner.className = "unrelated";
  shadowHost.setAttribute("aria-description", "unrelated");
  await Promise.resolve();
  expect(changedOuter).not.toHaveBeenCalled();
  expect(changedInner).not.toHaveBeenCalled();
  expect(changedShadow).not.toHaveBeenCalled();
});

it("isolates callbacks and keeps duplicate registrations independently disposable", async () => {
  const host = document.body.appendChild(document.createElement("section"));
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const notify = vi.fn();
  const failure = new Error("Inline presentation failed");
  let stopRetired = () => {};
  const stopFirst = observeLinkReaderInline(host, () => {
    stopRetired();
    throw failure;
  });
  stopRetired = observeLinkReaderInline(host, notify);
  const stopLast = observeLinkReaderInline(host, notify);
  onTestFinished(() => {
    stopFirst();
    stopRetired();
    stopLast();
  });
  host.append(document.createElement("a"));
  await Promise.resolve();
  expect(notify).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
});

it("keeps provider mutations scoped to their document", async () => {
  const first = document.body.appendChild(document.createElement("section"));
  const separateDocument = document.implementation.createHTMLDocument();
  const second = separateDocument.body.appendChild(separateDocument.createElement("section"));
  const changedFirst = vi.fn();
  const changedSecond = vi.fn();
  onTestFinished(observeLinkReaderInline(first, changedFirst));
  onTestFinished(observeLinkReaderInline(second, changedSecond));
  second.append(separateDocument.createElement("a"));
  await Promise.resolve();
  expect(changedFirst).not.toHaveBeenCalled();
  expect(changedSecond).toHaveBeenCalledOnce();
});
