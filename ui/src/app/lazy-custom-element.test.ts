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
    const requests = createLazyCustomElementRequests({ updateComplete: Promise.resolve(true) });
    return { requests, retryStale, cancelStale };
  }

  it.each([false, true])("retries a failed load and replays once (stale: %s)", async (stale) => {
    const error = new Error(
      stale ? "Failed to fetch dynamically imported module: panel-abc.js" : "chunk unavailable",
    );
    const { requests, retryStale } = createRequestHarness();
    const observed: Array<string | undefined> = [];
    const unsubscribe = requests.subscribe(() => observed.push(requests.visibleState?.status));
    const continuation = vi.fn();
    const element = failedElement(error, true);
    requests.request(element, continuation);
    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({ status: "error", element, error, stale }),
    );
    expect(continuation).not.toHaveBeenCalled();
    expect(observed).toContain("error");
    requests.retry();
    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    if (stale) {
      expect(retryStale.mock.calls[0]?.[0]?.canReload?.()).toBe(true);
    }
    await waitForFast(() => expect(continuation).toHaveBeenCalledOnce());
    expect(retryStale).toHaveBeenCalledTimes(stale ? 1 : 0);
    if (stale) {
      expect(retryStale.mock.calls[0]?.[0]?.canReload?.()).toBe(false);
    }
    expect(element.loadModule).toHaveBeenCalledTimes(2);
    expect(requests.visibleState).toBeUndefined();
    expect(observed.at(-1)).toBeUndefined();
    unsubscribe();
  });

  it("waits for the render commit and retains a replacement requested by the replay", async () => {
    const committed = createDeferred();
    const replacementLoad = createDeferred();
    const requests = createLazyCustomElementRequests({ updateComplete: committed.promise });
    const replacementAction = vi.fn();
    const replacement = definedElement(replacementLoad.promise);
    const action = vi.fn(() => requests.request(replacement, replacementAction));
    const first = definedElement();

    requests.request(first, action);
    await waitForFast(() => expect(customElements.get(first.tagName)).toBeDefined());
    expect(action).not.toHaveBeenCalled();
    committed.resolve();
    await waitForFast(() => expect(replacement.loadModule).toHaveBeenCalledOnce());
    expect(requests.visibleState).toMatchObject({ status: "loading", element: replacement });
    replacementLoad.resolve();
    await waitForFast(() => expect(replacementAction).toHaveBeenCalledOnce());
    expect(action).toHaveBeenCalledOnce();
    expect(requests.visibleState).toBeUndefined();
  });

  it("publishes successful preload registration without a visible request", async () => {
    const requests = createLazyCustomElementRequests();
    const published = vi.fn();
    requests.subscribe(published);
    const element = definedElement();

    requests.preload(element);
    await waitForFast(() => expect(published).toHaveBeenCalledOnce());
    expect(customElements.get(element.tagName)).toBeDefined();
    expect(requests.visibleState).toBeUndefined();
  });

  it("skips the action replay while the host has not rendered the element", async () => {
    // Replaying into a splash-gated shell can re-enter the loader and starve boot.
    const rendered = new Map<string, Element>();
    const host = {
      updateComplete: Promise.resolve(true),
      queryRenderedElement: (tagName: string) => rendered.get(tagName) ?? null,
    };
    const requests = createLazyCustomElementRequests(host);
    const action = vi.fn();
    const element = definedElement();

    requests.request(element, action);
    await waitForFast(() => expect(requests.visibleState).toBeUndefined());
    expect(action).not.toHaveBeenCalled();

    rendered.set(element.tagName, document.createElement(element.tagName));
    requests.request(element, action);
    await waitForFast(() => expect(action).toHaveBeenCalledOnce());
    expect(requests.visibleState).toBeUndefined();
  });

  it("resumes an active request after a foreground request replaces its visible slot", async () => {
    const activeLoad = createDeferred();
    const foregroundLoad = createDeferred();
    const { requests } = createRequestHarness();
    const activeElement = definedElement(activeLoad.promise);
    const foregroundElement = definedElement(foregroundLoad.promise);

    requests.requestWhileActive(activeElement, true);
    await waitForFast(() => expect(activeElement.loadModule).toHaveBeenCalledOnce());
    requests.request(foregroundElement);
    await waitForFast(() => expect(foregroundElement.loadModule).toHaveBeenCalledOnce());
    foregroundLoad.resolve();
    await waitForFast(() => expect(requests.visibleState?.element).toBe(activeElement));

    const error = new Error("active chunk unavailable");
    activeLoad.reject(error);
    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({
        element: activeElement,
        error,
        status: "error",
      }),
    );
  });

  it("keeps an active request dismissed until its lifecycle restarts", async () => {
    const error = new Error("active chunk unavailable");
    const { requests } = createRequestHarness();
    const element = failedElement(error, true);

    requests.requestWhileActive(element, true);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.close();
    requests.requestWhileActive(element, true);

    expect(requests.visibleState).toBeUndefined();
    expect(element.loadModule).toHaveBeenCalledOnce();

    requests.requestWhileActive(element, false);
    requests.requestWhileActive(element, true);
    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledTimes(2));
  });

  it("cancels pending page recovery only when a stale failure surface is retired", async () => {
    const staleError = new Error("Failed to fetch dynamically imported module: panel-abc.js");
    const { requests, cancelStale } = createRequestHarness();
    const stalePanel = failedElement(staleError);

    requests.request(stalePanel);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.abandon();
    expect(cancelStale).toHaveBeenCalledOnce();

    requests.request(stalePanel);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.retry();
    requests.close();
    expect(cancelStale).toHaveBeenCalledTimes(2);

    const brokenPanel = failedElement(new Error("render failed"));
    requests.request(brokenPanel);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.close();
    expect(cancelStale).toHaveBeenCalledTimes(2);
  });

  it("closes a loading request without replaying after its late definition", async () => {
    const load = createDeferred();
    const { requests } = createRequestHarness();
    const continuation = vi.fn();
    const element = definedElement(load.promise);

    requests.request(element, continuation);
    expect(requests.visibleState?.status).toBe("loading");
    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());

    requests.close();
    load.resolve();

    await waitForFast(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(requests.visibleState).toBeUndefined();
    expect(continuation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "publishes preload failures only when requested (reportError: %s)",
    async (reportError) => {
      const error = new Error("chunk unavailable");
      const { requests } = createRequestHarness();
      const element = failedElement(error);
      requests.preload(element, { reportError });
      requests.preload(element, { reportError });
      await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());
      if (reportError) {
        await waitForFast(() =>
          expect(requests.visibleState).toMatchObject({
            element,
            error,
            stale: false,
            status: "error",
          }),
        );
      } else {
        expect(requests.visibleState).toBeUndefined();
        requests.request(element);
        await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
        expect(element.loadModule).toHaveBeenCalledTimes(2);
      }
    },
  );
});
