/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForFast } from "../test-helpers/wait-for.ts";
import {
  ensureCustomElementDefined,
  createLazyCustomElementRequests,
} from "./lazy-custom-element.ts";
import * as staleRecovery from "./stale-chunk-reload.ts";

let tagSequence = 0;

const uniqueTag = () => `openclaw-lazy-test-${++tagSequence}`;

function definedElement(gate?: Promise<unknown>) {
  const tagName = uniqueTag();
  return {
    tagName,
    label: "test panel",
    loadModule: vi.fn(async () => {
      if (gate) {
        await gate;
      }
      customElements.define(tagName, class extends HTMLElement {});
    }),
  };
}

function failedElement(error: Error, recover = false) {
  const element = definedElement();
  if (recover) {
    element.loadModule.mockRejectedValueOnce(error);
  } else {
    element.loadModule.mockRejectedValue(error);
  }
  return element;
}

describe("ensureCustomElementDefined", () => {
  it("deduplicates concurrent module loads", async () => {
    const { tagName, loadModule } = definedElement();

    await Promise.all([
      ensureCustomElementDefined(tagName, loadModule),
      ensureCustomElementDefined(tagName, loadModule),
    ]);

    expect(loadModule).toHaveBeenCalledOnce();
    expect(customElements.get(tagName)).toBeDefined();
  });

  it("rejects modules that do not register their declared element", async () => {
    const tagName = uniqueTag();

    await expect(ensureCustomElementDefined(tagName, async () => undefined)).rejects.toThrow(
      `Custom element module did not define ${tagName}`,
    );
  });
});

describe("optional custom element requests", () => {
  function createRequestHarness() {
    const retryStale = vi
      .spyOn(staleRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const cancelStale = vi
      .spyOn(staleRecovery, "cancelStaleChunkRecovery")
      .mockImplementation(() => {});
    onTestFinished(() => {
      retryStale.mockRestore();
      cancelStale.mockRestore();
    });
    const requests = createLazyCustomElementRequests();
    return { requests, retryStale, cancelStale };
  }

  it.each([false, true])("retries a failed active load (stale: %s)", async (stale) => {
    const error = new Error(
      stale ? "Failed to fetch dynamically imported module: panel-abc.js" : "chunk unavailable",
    );
    const { requests, retryStale } = createRequestHarness();
    const observed: Array<string | undefined> = [];
    const unsubscribe = requests.subscribe(() => observed.push(requests.visibleState?.status));
    const element = failedElement(error, true);
    requests.requestWhileActive(element, true);
    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({ status: "error", element, error, stale }),
    );
    expect(observed).toContain("error");
    requests.retry();
    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    if (stale) {
      expect(retryStale.mock.calls[0]?.[0]?.canReload?.()).toBe(true);
    }
    await waitForFast(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(retryStale).toHaveBeenCalledTimes(stale ? 1 : 0);
    if (stale) {
      expect(retryStale.mock.calls[0]?.[0]?.canReload?.()).toBe(false);
    }
    expect(element.loadModule).toHaveBeenCalledTimes(2);
    expect(requests.visibleState).toBeUndefined();
    expect(observed.at(-1)).toBeUndefined();
    unsubscribe();
  });

  it("retains a replacement active request when the previous load completes", async () => {
    const firstLoad = createDeferred();
    const replacementLoad = createDeferred();
    const requests = createLazyCustomElementRequests();
    const replacement = definedElement(replacementLoad.promise);
    const first = definedElement(firstLoad.promise);

    requests.requestWhileActive(first, true);
    await waitForFast(() => expect(first.loadModule).toHaveBeenCalledOnce());
    requests.requestWhileActive(first, false);
    requests.requestWhileActive(replacement, true);
    await waitForFast(() => expect(replacement.loadModule).toHaveBeenCalledOnce());
    firstLoad.resolve();
    await waitForFast(() => expect(customElements.get(first.tagName)).toBeDefined());
    expect(requests.visibleState).toMatchObject({ status: "loading", element: replacement });
    replacementLoad.resolve();
    await waitForFast(() => expect(requests.visibleState).toBeUndefined());
  });

  it("cancels pending page recovery only when a stale failure surface is retired", async () => {
    const staleError = new Error("Failed to fetch dynamically imported module: panel-abc.js");
    const { requests, cancelStale } = createRequestHarness();
    const stalePanel = failedElement(staleError);

    requests.requestWhileActive(stalePanel, true);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.requestWhileActive(stalePanel, false);
    expect(cancelStale).toHaveBeenCalledOnce();

    requests.requestWhileActive(stalePanel, true);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.retry();
    requests.requestWhileActive(stalePanel, false);
    expect(cancelStale).toHaveBeenCalledTimes(2);

    const brokenPanel = failedElement(new Error("render failed"));
    requests.requestWhileActive(brokenPanel, true);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.requestWhileActive(brokenPanel, false);
    expect(cancelStale).toHaveBeenCalledTimes(2);
  });

  it("publishes late registration without restoring a deactivated request", async () => {
    const load = createDeferred();
    const { requests } = createRequestHarness();
    const published = vi.fn();
    requests.subscribe(published);
    const element = definedElement(load.promise);

    requests.requestWhileActive(element, true);
    expect(requests.visibleState?.status).toBe("loading");
    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());

    requests.requestWhileActive(element, false);
    published.mockClear();
    load.resolve();

    await waitForFast(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(requests.visibleState).toBeUndefined();
    expect(published).toHaveBeenCalledOnce();
  });
});
