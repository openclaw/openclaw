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

function uniqueTag(): string {
  tagSequence += 1;
  return `openclaw-lazy-test-${tagSequence}`;
}

describe("ensureCustomElementDefined", () => {
  it("deduplicates concurrent module loads", async () => {
    const tagName = uniqueTag();
    const loadModule = vi.fn(async () => {
      customElements.define(tagName, class extends HTMLElement {});
    });

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
    const host = { updateComplete: Promise.resolve(true) };
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
    const requests = createLazyCustomElementRequests(host);
    return { requests, retryStale, cancelStale };
  }

  it("publishes loading and error before retrying the canonical load and replaying once", async () => {
    const firstError = new Error("chunk unavailable");
    const { requests } = createRequestHarness();
    const observed: Array<string | undefined> = [];
    const unsubscribe = requests.subscribe(() => observed.push(requests.visibleState?.status));
    const continuation = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "test panel",
      loadModule: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(firstError)
        .mockImplementationOnce(async () => {
          customElements.define(tagName, class extends HTMLElement {});
        }),
    };

    requests.request(element, continuation);

    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({
        status: "error",
        element,
        error: firstError,
        stale: false,
      }),
    );
    expect(continuation).not.toHaveBeenCalled();
    expect(observed).toContain("error");

    requests.retry();

    expect(requests.visibleState).toMatchObject({ status: "loading", element });
    await waitForFast(() => expect(continuation).toHaveBeenCalledOnce());
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
    const replacement = {
      tagName: uniqueTag(),
      label: "replacement panel",
      loadModule: vi.fn(async () => {
        await replacementLoad.promise;
        customElements.define(replacement.tagName, class extends HTMLElement {});
      }),
    };
    const action = vi.fn(() => requests.request(replacement, replacementAction));
    const first = {
      tagName: uniqueTag(),
      label: "first panel",
      loadModule: async () => {
        customElements.define(first.tagName, class extends HTMLElement {});
      },
    };

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
    const element = {
      tagName: uniqueTag(),
      label: "preloaded panel",
      loadModule: async () => {
        customElements.define(element.tagName, class extends HTMLElement {});
      },
    };

    requests.preload(element);
    await waitForFast(() => expect(published).toHaveBeenCalledOnce());
    expect(customElements.get(element.tagName)).toBeDefined();
    expect(requests.visibleState).toBeUndefined();
  });

  it("skips the action replay while the host has not rendered the element", async () => {
    // Regression: replaying while the shell is still splash-gated re-dispatches
    // an event nothing handles, which re-enters the loader in a microtask
    // cycle that starves the boot (Gateway socket included).
    const rendered = new Map<string, Element>();
    const host = {
      updateComplete: Promise.resolve(true),
      queryRenderedElement: (tagName: string) => rendered.get(tagName) ?? null,
    };
    const requests = createLazyCustomElementRequests(host);
    const action = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "test panel",
      loadModule: async () => {
        customElements.define(tagName, class extends HTMLElement {});
      },
    };

    requests.request(element, action);
    await waitForFast(() => expect(requests.visibleState).toBeUndefined());
    expect(action).not.toHaveBeenCalled();

    rendered.set(tagName, document.createElement(tagName));
    requests.request(element, action);
    await waitForFast(() => expect(action).toHaveBeenCalledOnce());
    expect(requests.visibleState).toBeUndefined();
  });

  it("resumes an active request after a foreground request replaces its visible slot", async () => {
    let rejectActive: ((error: Error) => void) | undefined;
    let resolveForeground: (() => void) | undefined;
    const { requests } = createRequestHarness();
    const activeElement = {
      tagName: uniqueTag(),
      label: "active panel",
      loadModule: vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectActive = reject;
          }),
      ),
    };
    const foregroundElement = {
      tagName: uniqueTag(),
      label: "command palette",
      loadModule: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveForeground = () => {
              customElements.define(foregroundElement.tagName, class extends HTMLElement {});
              resolve();
            };
          }),
      ),
    };

    requests.requestWhileActive(activeElement, true);
    await waitForFast(() => expect(activeElement.loadModule).toHaveBeenCalledOnce());
    requests.request(foregroundElement);
    await waitForFast(() => expect(foregroundElement.loadModule).toHaveBeenCalledOnce());
    resolveForeground?.();
    await waitForFast(() => expect(requests.visibleState?.element).toBe(activeElement));

    const error = new Error("active chunk unavailable");
    rejectActive?.(error);
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
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "active panel",
      loadModule: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(error)
        .mockImplementationOnce(async () => {
          customElements.define(tagName, class extends HTMLElement {});
        }),
    };

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

  it("delegates stale recovery before falling back to the same in-place load", async () => {
    const staleError = new Error("Failed to fetch dynamically imported module: panel-abc.js");
    const { requests, retryStale } = createRequestHarness();
    const continuation = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "stale panel",
      loadModule: vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(staleError)
        .mockImplementationOnce(async () => {
          customElements.define(tagName, class extends HTMLElement {});
        }),
    };

    requests.request(element, continuation);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    expect(requests.visibleState).toMatchObject({ stale: true });

    requests.retry();
    expect(retryStale.mock.calls[0]?.[0]?.canReload?.()).toBe(true);

    await waitForFast(() => expect(continuation).toHaveBeenCalledOnce());
    expect(retryStale).toHaveBeenCalledOnce();
    expect(retryStale.mock.calls[0]?.[0]?.canReload?.()).toBe(false);
    expect(element.loadModule).toHaveBeenCalledTimes(2);
  });

  it("cancels pending page recovery only when a stale failure surface is retired", async () => {
    const staleError = new Error("Failed to fetch dynamically imported module: panel-abc.js");
    const { requests, cancelStale } = createRequestHarness();
    const stalePanel = {
      tagName: uniqueTag(),
      label: "stale panel",
      loadModule: vi.fn<() => Promise<void>>().mockRejectedValue(staleError),
    };

    requests.request(stalePanel);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.abandon();
    expect(cancelStale).toHaveBeenCalledOnce();

    requests.request(stalePanel);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.retry();
    requests.close();
    expect(cancelStale).toHaveBeenCalledTimes(2);

    const brokenPanel = {
      tagName: uniqueTag(),
      label: "broken panel",
      loadModule: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("render failed")),
    };
    requests.request(brokenPanel);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    requests.close();
    expect(cancelStale).toHaveBeenCalledTimes(2);
  });

  it("closes a loading request without replaying after its late definition", async () => {
    let resolveLoad: (() => void) | undefined;
    const { requests } = createRequestHarness();
    const continuation = vi.fn();
    const tagName = uniqueTag();
    const element = {
      tagName,
      label: "slow panel",
      loadModule: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveLoad = () => {
              customElements.define(tagName, class extends HTMLElement {});
              resolve();
            };
          }),
      ),
    };

    requests.request(element, continuation);
    expect(requests.visibleState?.status).toBe("loading");
    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());

    requests.close();
    resolveLoad?.();

    await waitForFast(() => expect(customElements.get(element.tagName)).toBeDefined());
    expect(requests.visibleState).toBeUndefined();
    expect(continuation).not.toHaveBeenCalled();
  });

  it("keeps preload failures silent until an explicit request owns visibility", async () => {
    const error = new Error("chunk unavailable");
    const { requests } = createRequestHarness();
    const element = {
      tagName: uniqueTag(),
      label: "preloaded panel",
      loadModule: vi.fn(async () => {
        throw error;
      }),
    };

    requests.preload(element);
    requests.preload(element);

    await waitForFast(() => expect(element.loadModule).toHaveBeenCalledOnce());
    expect(requests.visibleState).toBeUndefined();

    requests.request(element);
    await waitForFast(() => expect(requests.visibleState?.status).toBe("error"));
    expect(element.loadModule).toHaveBeenCalledTimes(2);
  });

  it("reports a preload failure when an active surface opts into recovery", async () => {
    const error = new Error("chunk unavailable");
    const { requests } = createRequestHarness();
    const element = {
      tagName: uniqueTag(),
      label: "active panel",
      loadModule: vi.fn(async () => {
        throw error;
      }),
    };

    requests.preload(element, { reportError: true });

    await waitForFast(() =>
      expect(requests.visibleState).toMatchObject({
        element,
        error,
        stale: false,
        status: "error",
      }),
    );
  });
});
