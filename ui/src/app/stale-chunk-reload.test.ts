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

function holdDocumentProbe(followingStatus?: number, repeat = true) {
  const probe = deferred<Response>();
  const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(() => probe.promise);
  if (followingStatus === undefined) {
    fetchMock.mockImplementation(() => probe.promise);
  } else if (repeat) {
    fetchMock.mockResolvedValue(httpResponse(followingStatus));
  } else {
    fetchMock.mockResolvedValueOnce(httpResponse(followingStatus));
  }
  vi.stubGlobal("fetch", fetchMock);
  return { probe, fetchMock };
}

function stubOfflineFetch() {
  const probe = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
  vi.stubGlobal("fetch", probe);
  return probe;
}

function stubUnavailableFetch() {
  const probe = vi.fn<typeof fetch>().mockResolvedValue(httpResponse(503));
  vi.stubGlobal("fetch", probe);
  return probe;
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
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("document probe aborted")), {
          once: true,
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
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

function scheduleRecovery(
  buildId?: string,
  overrides: Parameters<typeof scheduleStaleChunkReload>[0] = {},
) {
  return scheduleStaleChunkReload({ storage, reload, buildId, ...overrides });
}
function retryRecovery(
  timeoutMs?: number,
  overrides: Parameters<typeof retryStaleChunkReloadWhenReachable>[0] = {},
) {
  return retryStaleChunkReloadWhenReachable({ storage, reload, timeoutMs, ...overrides });
}
async function expectReload(pending: Promise<boolean>, buildId?: string) {
  await expect(pending).resolves.toBe(true);
  expect(reload).toHaveBeenCalledOnce();
  if (buildId) {
    expect(storage.getItem(GUARD_KEY)).toBe(guard(buildId));
  }
}
function expectCalls(probe: { mock: { calls: unknown[] } }, probes = 1) {
  expect(probe.mock.calls).toHaveLength(probes);
  expect(reload).toHaveBeenCalledOnce();
}

let reload: ReturnType<typeof vi.fn>;
let storage: ReturnType<typeof memoryStorage>;
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
      const probe = stubOfflineFetch();
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
    const probe = stubOfflineFetch();
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
    const probe = stubOfflineFetch();
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
    const { probe: response, fetchMock } = holdDocumentProbe(200);
    let allowed = false;
    const onBlocked = vi.fn();
    const release = registerControlUiReloadGuard(() => allowed, onBlocked);
    const attempt = () => (mode === "automatic" ? scheduleRecovery() : retryRecovery(0));
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
    const retry = () => retryRecovery(undefined, { storage: memoryStorage() });
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
  it("spreads build recovery once per target", async () => {
    vi.mocked(Math.random).mockReturnValue(0.25);
    const fetchMock = stubDocumentFetch(httpResponse(200));
    const recover = () => scheduleRecovery("new-build");
    const first = recover();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    const joined = recover();
    await vi.advanceTimersByTimeAsync(399);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(Promise.all([first, joined])).resolves.toEqual([true, false]);
    expectCalls(fetchMock);
    expect(storage.getItem(GUARD_KEY)).toBe(guard("new-build"));
    await expect(recover()).resolves.toBe(false);
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each(["online", "visible"])("wakes a pending recovery when %s", async (signal) => {
    const fetchMock = stubUnavailableFetch();
    const pending = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(60_000);
    fetchMock.mockResolvedValue(httpResponse(200));
    if (signal === "online") {
      window.dispatchEvent(new Event("online"));
    } else {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    }
    await vi.advanceTimersByTimeAsync(0);
    await expectReload(pending);
  });

  it("retires a generic wait when a newer build takes over", async () => {
    const fetchMock = stubDocumentFetch(httpResponse(503), httpResponse(200));
    const older = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(0);
    await expect(scheduleRecovery("new-build")).resolves.toBe(true);
    await expect(older).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expectCalls(fetchMock, 2);
  });

  it("never reloads a replacing document twice", async () => {
    const probe = stubDocumentFetch(httpResponse(200));
    await expect(scheduleRecovery()).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(29_999);
    await expect(scheduleRecovery()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(scheduleRecovery()).resolves.toBe(false);
    expectCalls(probe);
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
    await expectReload(pending);
  });

  it("keeps targeted recovery over generic failure", async () => {
    stubDocumentFetch(httpResponse(503), httpResponse(200));
    const targeted = scheduleRecovery("gateway-target", { reload: () => reload("targeted") });
    await vi.advanceTimersByTimeAsync(0);
    const generic = scheduleRecovery(undefined, { reload: () => reload("generic") });
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
    await expect(scheduleRecovery(undefined, { storage: null })).resolves.toBe(false);
    await expect(
      scheduleRecovery(undefined, {
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
        },
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it.each(["build-a", "build-b"])(
    "cools down an exhausted build, not a newer one: %s",
    async (nextBuild) => {
      const fetchMock = stubUnavailableFetch();
      const pending = scheduleRecovery("build-a");
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(storage.getItem(GUARD_KEY)).toBeNull();
      const attempts = fetchMock.mock.calls.length;
      expect(attempts).toBeGreaterThan(1);
      await expect(scheduleRecovery("build-a")).resolves.toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
      if (nextBuild === "build-a") {
        await vi.advanceTimersByTimeAsync(5_000);
      }
      fetchMock.mockResolvedValue(httpResponse(200));
      await expectReload(scheduleRecovery(nextBuild), nextBuild);
      expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
    },
  );

  it.each([false, true])(
    "reprobes a newer build on failure: replacement=%s",
    async (replaceOwner) => {
      const { probe: olderProbe, fetchMock } = holdDocumentProbe(200, false);
      const olderBuild = scheduleRecovery("build-a");
      let ownsNewerBuild = true;
      const newerBuild = scheduleRecovery("build-b", { canReload: () => ownsNewerBuild });
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
      expectCalls(fetchMock, 2);
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
    expectCalls(fetchMock);
    expect(storage.getItem(GUARD_KEY)).toBe(guard("build-b"));
  });

  it("isolates storage targets sharing a probe", async () => {
    const { probe: sharedProbe, fetchMock } = holdDocumentProbe();
    const firstStorage = memoryStorage();
    const secondStorage = memoryStorage();
    const first = scheduleRecovery("first-build", { storage: firstStorage });
    const second = scheduleRecovery("second-build", { storage: secondStorage });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    sharedProbe.resolve(httpResponse(503));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    fetchMock.mockResolvedValueOnce(httpResponse(200));
    await expect(retryRecovery(0, { storage: firstStorage })).resolves.toBe(true);
    expect(firstStorage.getItem(GUARD_KEY)).toBe(guard("first-build"));
    expect(secondStorage.getItem(GUARD_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps automatic target on join: manualFirst=%s", async (manualFirst) => {
    const { probe: sharedProbe } = holdDocumentProbe();
    storage = memoryStorage({ [GUARD_KEY]: "displayed-build" });
    const automatic = () => scheduleRecovery("target-build", { reload: () => reload("automatic") });
    const manual = () => retryRecovery(0, { reload: () => reload("manual") });
    const pending = manualFirst ? [manual(), automatic()] : [automatic(), manual()];
    sharedProbe.resolve(httpResponse(200));
    await expect(Promise.all(pending)).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe(guard("target-build"));
    if (manualFirst) {
      await expect(retryRecovery(0, { reload: () => reload("later") })).resolves.toBe(false);
      expect(reload).toHaveBeenCalledTimes(1);
    } else {
      expect(reload).toHaveBeenCalledExactlyOnceWith("automatic");
    }
  });

  it("settles and aborts a hanging document probe after its deadline", async () => {
    const fetchMock = stubHangingDocumentFetch();
    const retry = retryRecovery(0, { storage: undefined });
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
    expectCalls(fetchMock, 2);
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
    await expectReload(targeted);
  });

  it("rearms during a dismissed probe", async () => {
    const { probe: heldProbe } = holdDocumentProbe(200);
    const dismissed = scheduleRecovery();
    await vi.advanceTimersByTimeAsync(0);
    cancelStaleChunkRecovery(storage);
    // The next failure arrives while the aborted probe is still in flight.
    const rearmed = scheduleRecovery();
    heldProbe.resolve(httpResponse(503));
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await expect(dismissed).resolves.toBe(false);
    await expectReload(rearmed);
  });

  it("keeps automatic recovery running after a failed manual retry", async () => {
    failThenReachable();
    const automatic = scheduleRecovery();
    const manual = retryRecovery(0);
    await expect(manual).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await expectReload(automatic);
  });
});

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
      automatic ? scheduleStaleChunkReload() : retryStaleChunkReloadWhenReachable({ timeoutMs: 0 }),
    ).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `${location.origin}${resourceBase}/index.html`,
      expect.objectContaining({ method: "HEAD", cache: "no-store" }),
    );
    expect(replace).toHaveBeenCalledOnce();
    const destination = new URL(replace.mock.calls[0]![0]);
    expect(destination).toMatchObject({ pathname: location.pathname, hash: "#files" });
    expect(destination.searchParams.get("view")).toBe("split");
  },
);
describe("retryStaleChunkReloadWhenReachable", () => {
  it.each(["before", "during"] as const)(
    "does not reload when recovery is retired %s the document probe",
    async (retirement) => {
      const { probe: response, fetchMock: probe } = holdDocumentProbe();
      let current = retirement === "during";
      const pending = retryRecovery(undefined, { canReload: () => current, storage: undefined });
      current = false;
      response.resolve(httpResponse(200));
      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(retirement === "during" ? 1 : 0);
    },
  );

  it("admits one reload when retries complete together", async () => {
    const { probe: reachable, fetchMock: probe } = holdDocumentProbe();
    storage = memoryStorage({ [GUARD_KEY]: "replacement-build" });
    const retries = [retryRecovery(), retryRecovery()];
    reachable.resolve(httpResponse(200));
    await expect(Promise.all(retries)).resolves.toEqual([true, false]);
    expectCalls(probe);
    expect(storage.getItem(GUARD_KEY)).toBe(guard(CONTROL_UI_BUILD_INFO.buildId));
  });
});

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

  function setupStylesheetRecovery(ready: DocumentReadyState, ...responses: Response[]) {
    const replace = stubDocumentNavigation();
    const readyState = setReadyState(ready);
    const fetchMock = stubDocumentFetch(...responses);
    const uninstall = installMissingStylesheetRecovery();
    cleanups.push(uninstall);
    return { replace, readyState, fetchMock, uninstall };
  }

  it.each(["/fonts/geist.css", "/themes/claw.css", "/plugins/example/style.css"])(
    "ignores optional stylesheet failure: %s",
    async (href) => {
      const { replace, fetchMock: probe } = setupStylesheetRecovery("loading");
      dispatchStylesheetError(href);
      await vi.advanceTimersByTimeAsync(0);
      expect(probe).not.toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it("ignores errors with the CSS sentinel present", () => {
    document.documentElement.style.setProperty("--openclaw-css-ok", "1");
    const { fetchMock } = setupStylesheetRecovery("complete");
    window.dispatchEvent(new Event("load"));
    dispatchStylesheetError();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "recovers missing sentinel and deduplicates resource failure=%s",
    async (resourceFailure) => {
      const { replace, fetchMock } = setupStylesheetRecovery("loading", httpResponse(200));
      if (resourceFailure) {
        dispatchStylesheetError();
      }
      window.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(0);
      expect(replace).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it("shows a reload banner when automatic recovery is unavailable", async () => {
    const translations: Record<string, string> = {
      "lazyView.stylesFailed": "Localized stylesheet failure",
      "common.reload": "Localized reload",
    };
    const translate = vi.spyOn(i18n, "t").mockImplementation((key) => translations[key] ?? key);
    const { fetchMock } = setupStylesheetRecovery("complete", httpResponse(503), httpResponse(503));
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

  it("uninstall removes the banner and listeners", async () => {
    const setup = setupStylesheetRecovery("loading", httpResponse(503));
    setup.uninstall();
    dispatchStylesheetError();
    window.dispatchEvent(new Event("load"));
    expect(setup.fetchMock).not.toHaveBeenCalled();
    setup.readyState.mockReturnValue("complete");
    const uninstall = installMissingStylesheetRecovery();
    cleanups.push(uninstall);
    await vi.advanceTimersByTimeAsync(0);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    uninstall();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    dispatchStylesheetError();
    window.dispatchEvent(new Event("load"));
    expect(setup.fetchMock).toHaveBeenCalledOnce();
  });
});

it("bounds probes that ignore abort", async () => {
  const { probe: response } = holdDocumentProbe();
  const pending = retryRecovery(5_000, { storage: undefined });
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
it("honors deadlines after tab suspension", async () => {
  const probe = stubDocumentFetch(httpResponse(503));
  const pending = retryRecovery(5_000, { storage: undefined });
  await vi.advanceTimersByTimeAsync(0);
  // Wall time can move ahead while the tab is suspended, before its scheduled retry runs.
  vi.setSystemTime(Date.now() + 10_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await expect(pending).resolves.toBe(false);
  expect(probe).toHaveBeenCalledOnce();
  expect(reload).not.toHaveBeenCalled();
});
