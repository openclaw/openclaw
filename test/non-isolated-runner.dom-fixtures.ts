// Keep both files in the shared runner's existing child: the regression is the
// lifetime mismatch between a retired source generation and the native document.
export const domResourceFixtureFiles: Record<string, string> = {
  "dependency/node_modules/persistent-dom.cjs": `
exports.install = () => {
  window.addEventListener("error", event => {
    event.preventDefault();
    document.body.dataset.dependencyError = "observed";
  });
  document.addEventListener("dependency-event", () => document.body.dataset.dependencyEvent = "observed");
  const observer = new MutationObserver(() => document.body.dataset.dependencyMutation = "observed");
  observer.observe(document, { childList: true, subtree: true });
};
`,
  "11-dom-a-producer.test.ts": `
/* @vitest-environment jsdom */
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
it("registers live source and external dependency DOM resources", async () => {
  createRequire(import.meta.url)("./dependency/node_modules/persistent-dom.cjs").install();
  const temporaryErrorListener = () => {};
  window.addEventListener("error", temporaryErrorListener);
  window.removeEventListener("error", temporaryErrorListener);
  const listener = () => document.body.dataset.repoEvent = "observed";
  for (const target of [window, document, document.body, document.documentElement]) {
    target.addEventListener("repo-event", listener, true);
  }
  const ownerWindow = window;
  vi.stubGlobal("window", { addEventListener: ownerWindow.addEventListener.bind(ownerWindow) });
  window.addEventListener("repo-event", listener, true);
  vi.unstubAllGlobals();
  const observer = new MutationObserver(() => document.body.dataset.repoMutation = "observed");
  observer.observe(document, { childList: true, subtree: true });
  document.dispatchEvent(new Event("repo-event"));
  document.body.append(document.createElement("div"));
  await new Promise<void>(queueMicrotask);
  expect(document.body.dataset.repoEvent).toBe("observed");
  expect(document.body.dataset.repoMutation).toBe("observed");
  expect(document.body.dataset.dependencyMutation).toBe("observed");
  class RemovedPayload { value = "retained"; }
  function registerAndRemove() {
    const payload = new RemovedPayload();
    const callback = () => document.body.dataset.removedEvent = payload.value;
    document.addEventListener("removed-event", callback, { capture: true });
    document.removeEventListener("removed-event", callback, true);
    return new WeakRef(payload);
  }
  const removed = registerAndRemove();
  await setImmediate();
  expect(queryObjects(RemovedPayload)).toBe(0);
  expect(removed.deref()).toBeUndefined();
  document.dispatchEvent(new Event("removed-event"));
  expect(document.body.dataset.removedEvent).toBeUndefined();
  document.body.dataset.repoEvent = "";
  document.dispatchEvent(new Event("repo-event"));
  expect(document.body.dataset.repoEvent).toBe("observed");
  vi.stubGlobal("window", {
    addEventListener: ownerWindow.addEventListener.bind(ownerWindow),
    removeEventListener: ownerWindow.removeEventListener.bind(ownerWindow),
  });
  window.addEventListener("forwarded-event", () => document.body.dataset.forwardedEvent = "observed");
  ownerWindow.dispatchEvent(new Event("forwarded-event"));
  expect(document.body.dataset.forwardedEvent).toBe("observed");
});
`,
  "11-dom-b-observer.test.ts": `
/* @vitest-environment jsdom */
import { expect, it } from "vitest";
it("retires source DOM resources without breaking external dependencies", async () => {
  for (const target of [window, document, document.body, document.documentElement]) {
    target.dispatchEvent(new Event("repo-event"));
  }
  window.dispatchEvent(new Event("forwarded-event"));
  expect(document.body.dataset.forwardedEvent).toBeUndefined();
  document.dispatchEvent(new Event("dependency-event"));
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("handled dependency error"), cancelable: true }));
  expect(document.body.dataset.dependencyError).toBe("observed");
  document.body.append(document.createElement("div"));
  await new Promise<void>(queueMicrotask);
  expect(document.body.dataset.repoEvent).toBeUndefined();
  expect(document.body.dataset.repoMutation).toBeUndefined();
  expect(document.body.dataset.dependencyEvent).toBe("observed");
  expect(document.body.dataset.dependencyMutation).toBe("observed");
});
`,
};
