/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { observeDocumentRootAttributes } from "./document-root-attributes.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shares root observation while preserving filters, queued work and independent lifetimes", async () => {
  const NativeObserver = MutationObserver;
  const observers: MutationObserver[] = [];
  const observe = vi.spyOn(NativeObserver.prototype, "observe");
  const disconnect = vi.spyOn(NativeObserver.prototype, "disconnect");
  vi.stubGlobal(
    "MutationObserver",
    class extends NativeObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        observers.push(this);
      }
    },
  );
  const firstDocument = document.implementation.createHTMLDocument("First");
  const secondDocument = document.implementation.createHTMLDocument("Second");
  const root = firstDocument.documentElement;
  const changed = vi.fn();
  const siblings = Array.from({ length: 100 }, () =>
    observeDocumentRootAttributes(firstDocument, ["data-theme-mode", "style"], changed),
  );
  cleanup.push(...siblings);
  expect(observers).toHaveLength(1);
  expect(observe).toHaveBeenCalledExactlyOnceWith(root, {
    attributes: true,
    attributeFilter: ["data-theme-mode", "style"],
  });

  // Growing the native filter must not discard an earlier consumer's queued record.
  root.style.setProperty("--card", "white");
  const mascot = vi.fn();
  const stopMascot = observeDocumentRootAttributes(
    firstDocument,
    ["data-theme-mode", "data-theme-mascot"],
    mascot,
  );
  cleanup.push(stopMascot);
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(100);
  expect(mascot).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(2);

  const separate = vi.fn();
  cleanup.push(observeDocumentRootAttributes(secondDocument, ["data-theme-mode"], separate));
  expect(observers).toHaveLength(2);
  root.dataset.themeMode = "dark";
  root.dataset.themeMascot = "claw";
  root.dataset.unrelated = "ignored";
  firstDocument.body.dataset.themeMode = "light";
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(200);
  expect(mascot).toHaveBeenCalledOnce();
  expect(separate).not.toHaveBeenCalled();

  siblings[0]!();
  changed.mockClear();
  root.style.setProperty("--card", "black");
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(99);
  expect(mascot).toHaveBeenCalledOnce();
  siblings.slice(1).forEach((stop) => stop());
  expect(disconnect).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(3);
  changed.mockClear();
  root.style.setProperty("--card", "gray");
  secondDocument.documentElement.dataset.themeMode = "dark";
  await Promise.resolve();
  expect(changed).not.toHaveBeenCalled();
  expect(mascot).toHaveBeenCalledOnce();
  expect(separate).toHaveBeenCalledOnce();

  stopMascot();
  expect(disconnect.mock.contexts).toEqual([observers[0]]);
  cleanup.push(observeDocumentRootAttributes(firstDocument, ["data-theme-mode"], changed));
  expect(observers).toHaveLength(3);
  root.dataset.themeMode = "light";
  await Promise.resolve();
  expect(changed).toHaveBeenCalledOnce();
});

it("isolates callback errors and skips subscribers retired during a shared batch", async () => {
  const source = document.implementation.createHTMLDocument("Callbacks");
  const failure = new Error("Theme consumer failed");
  const reported = vi.fn();
  vi.stubGlobal("reportError", reported);
  let stopRetired = () => {};
  cleanup.push(
    observeDocumentRootAttributes(source, ["data-theme-mode"], () => {
      stopRetired();
      throw failure;
    }),
  );
  const retired = vi.fn();
  stopRetired = observeDocumentRootAttributes(source, ["data-theme-mode"], retired);
  const remaining = vi.fn();
  cleanup.push(stopRetired, observeDocumentRootAttributes(source, ["data-theme-mode"], remaining));
  source.documentElement.dataset.themeMode = "dark";
  await Promise.resolve();
  expect(reported).toHaveBeenCalledExactlyOnceWith(failure);
  expect(retired).not.toHaveBeenCalled();
  expect(remaining).toHaveBeenCalledOnce();
});
