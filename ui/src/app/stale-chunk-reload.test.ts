import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BASE_PATH_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { i18n } from "../i18n/index.ts";
import * as storageAccess from "../local-storage.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import {
  cancelStaleChunkRecovery,
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
  isStaleChunkImportError,
  retryControlUiImport,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

const GUARD_KEY = "openclaw.controlUi.staleChunkReloadBuildId";
const PROBE_TIMEOUT_MS = 10_000;

function guard(buildId: string, at = Date.now()) {
  return JSON.stringify({ buildId, at });
}

const httpResponse = (status: number) => new Response(null, { status });

function stubDocumentFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected document probe");
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function holdDocumentProbe() {
  const probe = deferred<Response>();
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => probe.promise);

  vi.stubGlobal("fetch", fetchMock);
  return { probe, fetchMock };
}

function failThenReachable() {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(httpResponse(503))
    .mockResolvedValue(httpResponse(200));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubHangingDocumentFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("document probe aborted")), {
          once: true,
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

function stubDocumentNavigation() {
  vi.useFakeTimers();
  const target = window;
  const replace = vi.fn();
  vi.stubGlobal("window", {
    location: { href: target.location.href, replace },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  vi.spyOn(storageAccess, "getSafeSessionStorage").mockReturnValue(memoryStorage());
  return replace;
}

function dispatchPreloadError(payload: unknown) {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.defineProperty(event, "payload", { value: payload });
  window.dispatchEvent(event);
}

function scheduleRecovery(buildId?: string) {
  return scheduleStaleChunkReload({ storage, reload, ...(buildId ? { buildId } : {}) });
}
function retryRecovery(timeoutMs?: number) {
  return retryStaleChunkReloadWhenReachable({
    storage,
    reload,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

let reload: ReturnType<typeof vi.fn>;
let storage: Storage;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  reload = vi.fn();
  storage = memoryStorage();
  vi.useFakeTimers({ now: 1_000 });
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  // Removing the stylesheet banner leaves its document recovery waiting for browser events.
  cancelStaleChunkRecovery();
  await vi.advanceTimersByTimeAsync(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
  document.documentElement.style.removeProperty("--openclaw-css-ok");
  document.documentElement.removeAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
});

describe("isStaleChunkImportError", () => {
  it.each([false, true])(
    "routes import retries before reloading: persistent=%s",
    async (persistent) => {
      const replace = stubDocumentNavigation();
      cleanups.push(installStaleChunkReloadListener());
      const probe = vi.fn().mockRejectedValue(new TypeError("offline"));
      vi.stubGlobal("fetch", probe);
      const failImport = async () => {
        const error = new TypeError("Failed to fetch dynamically imported module");
        dispatchPreloadError(error);
        throw error;
      };
      const load = vi
        .fn<() => Promise<string>>()
        .mockImplementationOnce(failImport)
        .mockImplementation(persistent ? failImport : async () => "loaded");
      const completion = retryControlUiImport(load).catch(async (error: unknown) => {
        expect(isStaleChunkImportError(error)).toBe(true);
        return scheduleStaleChunkReload({ reload, storage: memoryStorage() });
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reload).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledOnce();
      probe.mockResolvedValue(httpResponse(200));
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(1);
      await expect(completion).resolves.toBe(persistent ? true : "loaded");
      expect(load).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(persistent ? 1 : 0);
      expect(replace).not.toHaveBeenCalled();
    },
  );
  it("does not retry a failed CSS preload", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", probe);
    const failure = new Error("Unable to preload CSS for /assets/route-AbCd1234.css");
    const load = vi.fn().mockRejectedValue(failure);
    const pending = retryControlUiImport(load);
    const rejected = expect(pending).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledOnce();
    probe.mockResolvedValue(httpResponse(200));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(load).toHaveBeenCalledOnce();
  });

  it("does not rerun a retired route loader after reconnect", async () => {
    const probe = vi.fn().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", probe);
    const controller = new AbortController();
    const load = vi
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    const pending = retryControlUiImport(load, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    probe.mockResolvedValue(httpResponse(200));
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    expect(load).toHaveBeenCalledOnce();
  });
  it("ignores unrelated errors and non-error values", () => {
    expect(isStaleChunkImportError(new Error("request failed"))).toBe(false);
    expect(isStaleChunkImportError("Importing a module script failed.")).toBe(false);
    expect(isStaleChunkImportError(undefined)).toBe(false);
  });
});

describe("document reload ownership", () => {
  it.each(["automatic", "manual"])("rechecks %s reload authority after probing", async (mode) => {
    const response = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValue(httpResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    let allowed = false;
    const onBlocked = vi.fn();
    const release = registerControlUiReloadGuard(() => allowed, onBlocked);
    const attempt = () =>
      mode === "automatic"
        ? scheduleRecovery()
        : retryStaleChunkReloadWhenReachable({ storage, reload, timeoutMs: 0 });
    try {
      await expect(attempt()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(onBlocked).toHaveBeenCalledTimes(mode === "manual" ? 1 : 0);

      allowed = true;
      const pending = attempt();
      expect(fetchMock).toHaveBeenCalledOnce();
      allowed = false;
      response.resolve(httpResponse(200));
      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(storage.getItem(GUARD_KEY)).toBeNull();
      expect(onBlocked).toHaveBeenCalledTimes(mode === "manual" ? 2 : 0);

      release();
      vi.advanceTimersByTime(6_000);
      await expect(attempt()).resolves.toBe(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  });

  it("does not release another owner's reload protection", async () => {
    const firstBlocked = vi.fn();
    const secondBlocked = vi.fn();
    const releaseFirst = registerControlUiReloadGuard(() => false, firstBlocked);
    const releaseSecond = registerControlUiReloadGuard(() => false, secondBlocked);
    const probe = stubDocumentFetch(httpResponse(200));
    const retry = () => retryStaleChunkReloadWhenReachable({ reload, storage: memoryStorage() });
    try {
      releaseFirst();
      await expect(retry()).resolves.toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(firstBlocked).not.toHaveBeenCalled();
      expect(secondBlocked).toHaveBeenCalledOnce();
      releaseSecond();
      await expect(retry()).resolves.toBe(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
});

describe("scheduleStaleChunkReload", () => {
  it.each([{ draw: 0.25, delayMs: 500 }])(
    "spreads build recovery once per target: %j",
    async ({ draw, delayMs }) => {
      vi.mocked(Math.random).mockReturnValue(draw);

      const fetchMock = stubDocumentFetch(httpResponse(200));
      const recover = () => scheduleRecovery("new-build");
      const first = recover();
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      const joined = recover();
      await vi.advanceTimersByTimeAsync(delayMs - 101);
      expect(fetchMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(Promise.all([first, joined])).resolves.toEqual([true, false]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(reload).toHaveBeenCalledOnce();
      expect(storage.getItem(GUARD_KEY)).toBe(guard("new-build"));
      await expect(recover()).resolves.toBe(false);
      expect(reload).toHaveBeenCalledOnce();
    },
  );

  it.each(["online", "visible"])("wakes a pending recovery when %s", async (signal) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    const pending = scheduleStaleChunkReload({ storage: memoryStorage(), reload });
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockResolvedValue(httpResponse(200));
    if (signal === "online") {
      window.dispatchEvent(new Event("online"));
    } else {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("retires a generic wait when a newer build takes over", async () => {
    const fetchMock = stubDocumentFetch(httpResponse(503), httpResponse(200));
    const older = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(0);
    await expect(scheduleRecovery("new-build")).resolves.toBe(true);
    await expect(older).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("never reloads a replacing document twice", async () => {
    const probe = stubDocumentFetch(httpResponse(200));
    await expect(scheduleRecovery()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    await expect(scheduleRecovery()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(scheduleRecovery()).resolves.toBe(false);
    expect(probe).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("defers recovery in a reloaded document until the loop guard expires", async () => {
    // A fresh document inherits only the persisted guard from the reload that created it.
    storage = memoryStorage({ [GUARD_KEY]: guard(CONTROL_UI_BUILD_INFO.buildId) });
    const fetchMock = stubDocumentFetch(httpResponse(200));
    const pending = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps targeted recovery over generic failure", async () => {
    stubDocumentFetch(httpResponse(503), httpResponse(200));
    const targeted = scheduleStaleChunkReload({
      buildId: "gateway-target",
      storage,
      reload: () => reload("targeted"),
    });
    await vi.advanceTimersByTimeAsync(0);
    const generic = scheduleStaleChunkReload({ storage, reload: () => reload("generic") });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all([targeted, generic])).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledExactlyOnceWith("targeted");
    expect(storage.getItem(GUARD_KEY)).toBe(guard("gateway-target"));
  });

  it("does not guard a newer build", async () => {
    storage = memoryStorage({ [GUARD_KEY]: guard("build-a") });
    stubDocumentFetch(httpResponse(200));
    const guardedRecovery = scheduleRecovery("build-a");
    await vi.advanceTimersByTimeAsync(0);
    expect(reload).not.toHaveBeenCalled();
    await expect(scheduleRecovery("build-b")).resolves.toBe(true);
    await expect(guardedRecovery).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe(guard("build-b"));
  });

  it("does not auto-reload when the guard cannot be persisted", async () => {
    stubDocumentFetch(httpResponse(200), httpResponse(200));
    await expect(
      scheduleStaleChunkReload({
        storage: null,
        reload,
      }),
    ).resolves.toBe(false);
    await expect(
      scheduleStaleChunkReload({
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
        },
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("applies an in-memory cooldown after bounded recovery expires", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    const pending = scheduleRecovery("build-a");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(GUARD_KEY)).toBeNull();
    const attempts = fetchMock.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    await expect(scheduleRecovery("build-a")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);

    await vi.advanceTimersByTimeAsync(5_000);
    fetchMock.mockResolvedValue(httpResponse(200));
    await expect(scheduleRecovery("build-a")).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
  });

  it("probes a newer build immediately after an older build exhausted recovery", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(httpResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    const older = scheduleRecovery("build-a");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(older).resolves.toBe(false);
    const attempts = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue(httpResponse(200));
    await expect(scheduleRecovery("build-b")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(GUARD_KEY)).toBe(guard("build-b"));
  });

  it.each([false, true])(
    "reprobes a newer build on failure: replacement=%s",
    async (replaceOwner) => {
      const olderProbe = deferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => olderProbe.promise)
        .mockResolvedValueOnce(httpResponse(200));
      vi.stubGlobal("fetch", fetchMock);

      const olderBuild = scheduleRecovery("build-a");
      let ownsNewerBuild = true;
      const newerBuild = scheduleStaleChunkReload({
        buildId: "build-b",
        storage,
        reload,
        canReload: () => ownsNewerBuild,
      });
      const results = [olderBuild, newerBuild];
      if (replaceOwner) {
        ownsNewerBuild = false;
        results.push(scheduleRecovery("build-b"));
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);

      olderProbe.resolve(httpResponse(503));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(Promise.all(results)).resolves.toEqual(
        replaceOwner ? [false, false, true] : [false, true],
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(storage.getItem(GUARD_KEY)).toBe(guard("build-b"));
    },
  );

  it("reloads only the newest build after a shared document probe succeeds", async () => {
    const { probe: sharedProbe, fetchMock } = holdDocumentProbe();

    const olderBuild = scheduleRecovery("build-a");
    const newerBuild = scheduleRecovery("build-b");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sharedProbe.resolve(httpResponse(200));
    await expect(Promise.all([olderBuild, newerBuild])).resolves.toEqual([false, true]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe(guard("build-b"));
  });

  it("isolates storage targets sharing a probe", async () => {
    const { probe: sharedProbe, fetchMock } = holdDocumentProbe();
    const firstStorage = memoryStorage();
    const secondStorage = memoryStorage();

    const first = scheduleStaleChunkReload({
      buildId: "first-build",
      storage: firstStorage,
      reload,
    });
    const second = scheduleStaleChunkReload({
      buildId: "second-build",
      storage: secondStorage,
      reload,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sharedProbe.resolve(httpResponse(503));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    fetchMock.mockResolvedValueOnce(httpResponse(200));
    await expect(
      retryStaleChunkReloadWhenReachable({
        reload,
        storage: firstStorage,
        timeoutMs: 0,
      }),
    ).resolves.toBe(true);
    expect(firstStorage.getItem(GUARD_KEY)).toBe(guard("first-build"));
    expect(secondStorage.getItem(GUARD_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("keeps automatic target on manual join", async () => {
    const { probe: sharedProbe } = holdDocumentProbe();
    storage = memoryStorage({ [GUARD_KEY]: "displayed-build" });

    const automatic = scheduleStaleChunkReload({
      buildId: "target-build",
      storage,
      reload: () => reload("automatic"),
    });
    const manual = retryStaleChunkReloadWhenReachable({
      reload: () => reload("manual"),
      storage,
      timeoutMs: 0,
    });
    sharedProbe.resolve(httpResponse(200));

    await expect(Promise.all([automatic, manual])).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledExactlyOnceWith("automatic");
    expect(storage.getItem(GUARD_KEY)).toBe(guard("target-build"));
  });

  it("keeps automatic target when joining manual", async () => {
    const { probe: sharedProbe } = holdDocumentProbe();
    storage = memoryStorage({ [GUARD_KEY]: "displayed-build" });

    const manual = retryStaleChunkReloadWhenReachable({
      reload: () => reload("manual"),
      storage,
      timeoutMs: 0,
    });
    const automatic = scheduleStaleChunkReload({
      buildId: "target-build",
      storage,
      reload: () => reload("automatic"),
    });
    sharedProbe.resolve(httpResponse(200));

    await expect(Promise.all([manual, automatic])).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe(guard("target-build"));
    await expect(
      retryStaleChunkReloadWhenReachable({
        reload: () => reload("later"),
        storage,
        timeoutMs: 0,
      }),
    ).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("settles and aborts a hanging document probe after its deadline", async () => {
    const fetchMock = stubHangingDocumentFetch();
    const retry = retryStaleChunkReloadWhenReachable({ reload, timeoutMs: 0 });

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const result = expect(retry).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await result;

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("stops automatic retries after manual success", async () => {
    const fetchMock = failThenReachable();

    const automatic = scheduleRecovery("gateway-target");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const reloadedAt = Date.now();
    await expect(retryRecovery(0)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(automatic).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(GUARD_KEY)).toBe(guard("gateway-target", reloadedAt));
  });

  it("dismisses only generic recovery", async () => {
    failThenReachable();

    const generic = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(0);
    cancelStaleChunkRecovery(storage);
    await expect(generic).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();

    const targeted = scheduleRecovery("gateway-target");
    cancelStaleChunkRecovery(storage);
    await expect(targeted).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("rearms during a dismissed probe", async () => {
    const heldProbe = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () => heldProbe.promise)
      .mockResolvedValue(httpResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const dismissed = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(0);
    cancelStaleChunkRecovery(storage);
    // The next failure arrives while the aborted probe is still in flight.
    const rearmed = scheduleRecovery();
    heldProbe.resolve(httpResponse(503));
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

    await expect(dismissed).resolves.toBe(false);
    await expect(rearmed).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps automatic recovery running after a failed manual retry", async () => {
    failThenReachable();

    const automatic = scheduleRecovery();
    const manual = retryRecovery(0);
    await expect(manual).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(automatic).resolves.toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("retryStaleChunkReloadWhenReachable single-shot", () => {
  it.each([
    { routeBase: "", resourceBase: "", automatic: false },
    { routeBase: "/control", resourceBase: "/control", automatic: false },
    { routeBase: "/portable", resourceBase: "", automatic: false },
    { routeBase: "/control", resourceBase: "/control", automatic: true },
    { routeBase: "", resourceBase: "", automatic: false, devGateway: true },
  ])(
    "reloads a chat deep link through its serving document ($routeBase, $resourceBase, automatic: $automatic, dev: $devGateway)",
    async ({ routeBase, resourceBase, automatic, devGateway }) => {
      const replace = stubDocumentNavigation();
      const location = new URL(
        `http://localhost${routeBase}/chat/main/12345678aaaa40008000000000000001?view=split#files`,
      );
      Object.assign(window.location, { href: location.href, pathname: location.pathname });
      document.documentElement.setAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE, resourceBase);
      if (devGateway) {
        vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
          gatewayUrl: "ws://gateway.example/control",
          proxyPath: "/__gateway__",
        });
      }
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const target = new URL(input instanceof Request ? input.url : input, location);
        // Canonical chat documents deliberately reject HEAD before reading a session.
        return new Response(null, {
          status: target.pathname === `${resourceBase}/index.html` ? 200 : 405,
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        automatic
          ? scheduleStaleChunkReload()
          : retryStaleChunkReloadWhenReachable({ timeoutMs: 0 }),
      ).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
        `${location.origin}${resourceBase}/index.html`,
        expect.objectContaining({ method: "HEAD", cache: "no-store" }),
      );
      expect(replace).toHaveBeenCalledOnce();
      const destination = new URL(replace.mock.calls[0]![0]);
      expect(destination.pathname).toBe(location.pathname);
      expect(destination.searchParams.get("view")).toBe("split");
      expect(destination.hash).toBe("#files");
    },
  );
});

describe("retryStaleChunkReloadWhenReachable", () => {
  it.each(["before", "during"] as const)(
    "does not reload when recovery is retired %s the document probe",
    async (retirement) => {
      const response = deferred<Response>();
      const probe = vi.fn<typeof fetch>(() => response.promise);
      vi.stubGlobal("fetch", probe);
      let current = retirement === "during";
      const pending = retryStaleChunkReloadWhenReachable({ canReload: () => current, reload });
      current = false;
      response.resolve(httpResponse(200));
      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(retirement === "during" ? 1 : 0);
    },
  );

  it("admits one reload when retries complete together", async () => {
    const reachable = deferred<Response>();
    storage = memoryStorage({ [GUARD_KEY]: "replacement-build" });
    const probe = vi.fn<typeof fetch>(() => reachable.promise);
    vi.stubGlobal("fetch", probe);
    const retries = [
      retryStaleChunkReloadWhenReachable({ reload, storage }),
      retryStaleChunkReloadWhenReachable({ reload, storage }),
    ];
    reachable.resolve(httpResponse(200));
    await expect(Promise.all(retries)).resolves.toEqual([true, false]);
    expect(probe).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe(guard(CONTROL_UI_BUILD_INFO.buildId));
  });
});

describe("installStaleChunkReloadListener", () => {
  it("recovers lazy imports, not evaluation errors", async () => {
    const replace = stubDocumentNavigation();
    const fetchMock = stubDocumentFetch(httpResponse(200));
    cleanups.push(installStaleChunkReloadListener());
    dispatchPreloadError(new Error("boom in module evaluation"));
    expect(fetchMock).not.toHaveBeenCalled();
    dispatchPreloadError(new Error("Importing a module script failed."));
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("installMissingStylesheetRecovery", () => {
  function setReadyState(readyState: DocumentReadyState) {
    return vi.spyOn(document, "readyState", "get").mockReturnValue(readyState);
  }

  function dispatchStylesheetError(href = "/assets/index-AbCd1234.css") {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.append(link);
    link.dispatchEvent(new Event("error"));
    link.remove();
  }

  it.each(["/fonts/geist.css", "/themes/claw.css", "/plugins/example/style.css"])(
    "ignores optional stylesheet failure: %s",
    async (href) => {
      const replace = stubDocumentNavigation();
      setReadyState("loading");
      const probe = stubDocumentFetch();
      cleanups.push(installMissingStylesheetRecovery());
      dispatchStylesheetError(href);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("ignores errors with the CSS sentinel present", () => {
    stubDocumentNavigation();
    setReadyState("complete");
    document.documentElement.style.setProperty("--openclaw-css-ok", "1");
    const fetchMock = stubDocumentFetch();
    cleanups.push(installMissingStylesheetRecovery());
    window.dispatchEvent(new Event("load"));
    dispatchStylesheetError();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("schedules recovery when the sentinel is missing at load", async () => {
    const replace = stubDocumentNavigation();
    setReadyState("loading");
    const fetchMock = stubDocumentFetch(httpResponse(200));
    cleanups.push(installMissingStylesheetRecovery());
    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("shows a reload banner when automatic recovery is unavailable", async () => {
    stubDocumentNavigation();
    const translate = vi.spyOn(i18n, "t").mockImplementation((key) => {
      if (key === "lazyView.stylesFailed") {
        return "Localized stylesheet failure";
      }
      if (key === "common.reload") {
        return "Localized reload";
      }
      return key;
    });
    setReadyState("complete");
    const fetchMock = stubDocumentFetch(httpResponse(503), httpResponse(503));
    cleanups.push(installMissingStylesheetRecovery());
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    const banner = document.querySelector<HTMLElement>('[role="alert"]');
    const reloadButton = banner?.querySelector<HTMLButtonElement>("button");
    expect(banner?.textContent).toContain("Localized stylesheet failure");
    expect(reloadButton?.textContent).toBe("Localized reload");
    expect(translate).toHaveBeenCalledWith("lazyView.stylesFailed", undefined);
    expect(translate).toHaveBeenCalledWith("common.reload", undefined);
    reloadButton?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(banner?.isConnected).toBe(true);
  });

  it("deduplicates resource and load failures", async () => {
    const replace = stubDocumentNavigation();
    setReadyState("loading");
    const fetchMock = stubDocumentFetch(httpResponse(200));
    cleanups.push(installMissingStylesheetRecovery());
    dispatchStylesheetError();
    window.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(0);
    expect(replace).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uninstall removes the banner and listeners", async () => {
    stubDocumentNavigation();
    const readyState = setReadyState("loading");
    const fetchMock = stubDocumentFetch(httpResponse(503));
    const uninstallListeners = installMissingStylesheetRecovery();
    uninstallListeners();
    dispatchStylesheetError();
    window.dispatchEvent(new Event("load"));
    expect(fetchMock).not.toHaveBeenCalled();

    readyState.mockReturnValue("complete");
    const uninstall = installMissingStylesheetRecovery();

    cleanups.push(uninstall);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    uninstall();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    dispatchStylesheetError();
    window.dispatchEvent(new Event("load"));
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("retryStaleChunkReloadWhenReachable deadline enforcement", () => {
  it("bounds probes that ignore abort", async () => {
    const response = deferred<Response>();
    const probe = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", probe);
    const pending = retryStaleChunkReloadWhenReachable({ reload, timeoutMs: 5_000 });
    try {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      response.resolve(httpResponse(503));
      await vi.advanceTimersByTimeAsync(0);
    }
  });
});

it("honors deadlines after tab suspension", async () => {
  const probe = stubDocumentFetch(httpResponse(503));
  const pending = retryStaleChunkReloadWhenReachable({ reload, timeoutMs: 5_000 });
  await vi.advanceTimersByTimeAsync(0);
  // Wall time can move ahead while the tab is suspended, before its scheduled retry runs.
  vi.setSystemTime(Date.now() + 10_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(pending).resolves.toBe(false);
  expect(probe).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
});
