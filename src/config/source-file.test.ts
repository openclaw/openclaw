import fs from "node:fs/promises";
import path from "node:path";
import * as pathAdmission from "@openclaw/fs-safe/advanced";
import { root, type Root } from "@openclaw/fs-safe/root";
import * as observation from "@openclaw/fs-safe/watch";
import type {
  WatchInvalidation,
  WatchHealth,
  WatchOptions,
  WatchSubscription,
} from "@openclaw/fs-safe/watch";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { ConfigIncludeReadError, resolveConfigIncludes } from "./includes.js";
import * as admission from "./source-file-roots.js";
import { createConfigFileAdapter } from "./source-file.js";

const planConfigScopes = admission.configObservationScopes;

// Copy the external ESM namespace so test instrumentation can wrap watch while
// integration cases still execute the installed implementation unchanged.
vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));
vi.mock("@openclaw/fs-safe/watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/watch")>()),
}));

describe("config file adapter", () => {
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  const adapters = new Set<ReturnType<typeof createConfigFileAdapter>>();
  let authority: Root;
  let open: Root["open"];
  let sampledOpen: import("vitest").MockInstance<Root["open"]>;
  let directory: string;
  const p = (name: string) => path.join(directory, name);
  beforeAll(async () => {
    directory = dirs.make("config-observation-");
    authority = await root(directory, { symlinks: "reject" });
    open = authority.open.bind(authority);
    await fs.writeFile(p("openclaw.json"), "{}");
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("CHOKIDAR_USEPOLLING", undefined);
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    vi.spyOn(admission, "admitConfigObservationRoots").mockResolvedValue([
      { authority, boundaries: [directory] },
    ]);
    vi.spyOn(admission, "configObservationScopes").mockImplementation(async (_root, entries) =>
      [...entries.keys()].map((relative) => ({ path: relative, kind: "entry" })),
    );
    sampledOpen = vi
      .spyOn(authority, "open")
      .mockRejectedValue(new Error("missing synthetic file"));
  });
  afterEach(async () => {
    await Promise.allSettled([...adapters].map((adapter) => adapter.stop()));
    adapters.clear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createHarness(included: string[] = [], configPath = p("openclaw.json")) {
    const observers: Array<ReturnType<typeof fakeObserver>> = [];
    const watch = vi.spyOn(observation, "watch").mockImplementation((_root, options) => {
      const next = fakeObserver(options);
      observers.push(next);
      return next.subscription;
    });
    const onChange = vi.fn();
    const onReady = vi.fn();
    const log = { warn: vi.fn(), error: vi.fn() };
    const adapter = createConfigFileAdapter({
      path: configPath,
      includedPaths: included,
      onChange,
      onReady,
      log,
    });
    adapters.add(adapter);
    const current = () => {
      const next = observers.at(-1);
      if (!next) {
        throw new Error("observer not admitted");
      }
      return next;
    };
    const start = async () => {
      adapter.start();
      await vi.advanceTimersByTimeAsync(0);
    };
    const dirty = async (name?: string, reason: WatchInvalidation["reason"] = "event") => {
      current().dirty(name, reason);
      await vi.advanceTimersByTimeAsync(250);
    };
    return { adapter, observers, watch, onChange, onReady, log, current, start, dirty };
  }

  function fakeObserver(options: WatchOptions) {
    const ready = createDeferred();
    void ready.promise.catch(() => {});
    let closed = false;
    const close = vi.fn(async () => {
      closed = true;
      ready.reject(new Error("closed"));
    });
    const subscription: WatchSubscription = {
      ready: ready.promise,
      setScopes: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      health: () => ({
        state: closed ? "closed" : "ready",
        mode: options.mode === "poll" ? "poll" : "events",
        directories: 1,
      }),
      close,
      async [Symbol.asyncDispose]() {
        await subscription.close();
      },
    };
    return {
      subscription,
      close,
      options,
      ready: () => ready.resolve(),
      dirty: (relative?: string, reason: WatchInvalidation["reason"] = "event") =>
        options.onInvalidate({
          reason,
          ...(relative === undefined ? {} : { changes: [{ path: relative, type: "content" }] }),
        }),
      fail: (
        error = new Error("watch resources exhausted"),
        failure: Omit<NonNullable<WatchHealth["failure"]>, "error"> = {
          operation: "watch",
          code: "watch-limit",
        },
      ) =>
        options.onHealth?.({
          ...subscription.health(),
          state: "unavailable",
          failure: { ...failure, error },
        }),
    };
  }

  it("keeps bootstrap invalidation out of config changes while preserving later unknown invalidation", async () => {
    const h = createHarness();
    await h.start();
    h.current().dirty(undefined, "reconcile");
    h.current().ready();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(h.onChange).not.toHaveBeenCalled();
    await h.dirty();
    expect(h.onChange).toHaveBeenCalledOnce();
  });

  it("preserves actual unknown activity during startup", async () => {
    const h = createHarness();
    await h.start();
    h.current().dirty(undefined, "overflow");
    h.current().ready();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(h.onChange).toHaveBeenCalledOnce();
  });

  it("starts explicitly and invalidates replacements without accepting retired callbacks", async () => {
    const h = createHarness();
    expect(h.watch).not.toHaveBeenCalled();
    await h.start();
    h.adapter.start();
    expect(h.watch).toHaveBeenCalledOnce();
    const first = h.current();
    first.ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onReady).toHaveBeenCalledOnce();
    await h.adapter.observePaths([p("hooks.json5")]);
    await vi.advanceTimersByTimeAsync(0);
    first.dirty("openclaw.json");
    first.fail();
    expect(h.onChange).not.toHaveBeenCalled();
    h.current().ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onChange).toHaveBeenCalledOnce();
    await h.adapter.stop();
    h.current().dirty();
    await vi.runAllTimersAsync();
    expect(h.onChange).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent selections across held retirement without leaking or losing a no-op update", async () => {
    vi.spyOn(pathAdmission, "canonicalPathFromExistingAncestor").mockResolvedValue(
      p("openclaw.json"),
    );
    const h = createHarness();
    await h.start();
    const previous = h.current();
    previous.ready();
    await vi.advanceTimersByTimeAsync(0);
    const held = createDeferred();
    previous.close.mockReturnValue(held.promise);
    const first = h.adapter.observePaths([p("first.json")]);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(previous.close).toHaveBeenCalledOnce();
      const latest = h.adapter.acceptPaths([p("latest.json")]);
      await vi.advanceTimersByTimeAsync(0);
      await h.adapter.acceptPaths([p("latest.json")]);
      expect(h.watch).toHaveBeenCalledOnce();
      held.resolve();
      await Promise.all([first, latest]);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.watch).toHaveBeenCalledTimes(2);
      expect(h.current().options.scopes).toEqual([
        { path: "openclaw.json", kind: "entry" },
        { path: "latest.json", kind: "entry" },
      ]);
      await h.adapter.stop();
      expect(h.observers.every((observer) => observer.close.mock.calls.length === 1)).toBe(true);
    } finally {
      held.resolve();
      await first;
      await h.adapter.stop();
    }
  });

  it.each(["unavailable", "close"] as const)(
    "handles readiness rejection during held scope admission on %s",
    async (reason) => {
      const h = createHarness(
        Array.from({ length: 128 }, (_, index) => p(`include-${index}.json`)),
      );
      const scopes =
        createDeferred<Awaited<ReturnType<typeof admission.configObservationScopes>>>();
      vi.mocked(admission.configObservationScopes)
        .mockImplementationOnce(async (_root, entries) =>
          [...entries.keys()].map((relative) => ({ path: relative, kind: "entry" })),
        )
        .mockReturnValueOnce(scopes.promise);
      const firstReady = createDeferred();
      const watch = h.watch.getMockImplementation()!;
      h.watch.mockImplementation((admittedRoot, options) => ({
        ...watch(admittedRoot, options),
        ready: firstReady.promise,
      }));
      await h.start();
      expect(admission.configObservationScopes).toHaveBeenCalledTimes(2);
      expect(h.watch).toHaveBeenCalledOnce();
      const failure = new Error("subscription retired while another scope was admitting");
      if (reason === "unavailable") {
        h.current().fail(failure);
      }
      const finished = vi.fn();
      const stopping = h.adapter.stop().then(finished);
      firstReady.reject(failure);
      try {
        // Give unhandled rejection reporting a turn while scope admission is
        // still held; the adapter must already own the rejected ready promise.
        await vi.advanceTimersByTimeAsync(0);
        expect(finished).not.toHaveBeenCalled();
        expect(h.current().close).toHaveBeenCalledOnce();
        expect(h.onReady).not.toHaveBeenCalled();
      } finally {
        scopes.resolve([]);
        await stopping;
      }
      expect(finished).toHaveBeenCalledOnce();
      expect(h.watch).toHaveBeenCalledOnce();
    },
  );

  it("settles a canonical file change without rebuilding an unrelated indirect alias scope", async () => {
    const alias = path.join("alias", "include.json");
    const canonical = path.join("canonical", "include.json");
    vi.mocked(admission.configObservationScopes).mockImplementation(async (_root, entries) =>
      [...entries.keys()].map((relative) => ({
        path: relative === alias ? "alias" : relative,
        kind: "entry",
      })),
    );
    const h = createHarness([p(alias), p(canonical)]);
    await h.start();
    h.current().ready();
    await vi.advanceTimersByTimeAsync(0);
    const structural = (relative: string) =>
      h.current().options.onInvalidate({
        reason: "reconcile",
        changes: [{ path: relative, type: "structural" }],
      });
    structural(canonical);
    expect(h.onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(199);
    expect(h.onChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(51);
    expect(h.onChange).toHaveBeenCalledOnce();
    expect(h.watch).toHaveBeenCalledOnce();
    structural("alias");
    expect(h.onChange).toHaveBeenCalledTimes(2);
  });

  it("retains accepted includes, retires old candidates, and filters directory children", async () => {
    const h = createHarness([p("accepted.json5")]);
    await h.start();
    await h.adapter.observePaths([p("first.json5")]);
    await vi.advanceTimersByTimeAsync(0);
    await h.dirty("accepted.json5");
    await h.dirty("first.json5");
    expect(h.onChange).toHaveBeenCalledTimes(2);
    await h.adapter.observePaths([p("rejected-directory")]);
    await vi.advanceTimersByTimeAsync(0);
    await h.dirty("first.json5");
    await h.dirty(path.join("rejected-directory", "session.json"));
    expect(h.onChange).toHaveBeenCalledTimes(2);
    await h.dirty("rejected-directory");
    await h.adapter.acceptPaths([p("replacement.json5")]);
    await vi.advanceTimersByTimeAsync(0);
    await h.dirty("accepted.json5");
    await h.dirty("replacement.json5");
    expect(h.onChange).toHaveBeenCalledTimes(4);
    const creations = h.watch.mock.calls.length;
    await h.adapter.acceptPaths([p("replacement.json5")]);
    expect(h.watch).toHaveBeenCalledTimes(creations);
    expect(h.current().options.scopes).toEqual([
      { path: "openclaw.json", kind: "entry" },
      { path: "replacement.json5", kind: "entry" },
    ]);
  });

  it.each([
    "outside pinned roots",
    "unwatchable name",
    "unwatchable name in another root",
  ] as const)(
    "keeps primary and accepted include observation after a rejected candidate %s",
    async (reason) => {
      const accepted = p("accepted.json");
      const includeDirectory =
        reason === "unwatchable name in another root"
          ? dirs.make("config-invalid-include-root-")
          : undefined;
      const includeAuthority = includeDirectory
        ? await root(includeDirectory, { symlinks: "reject" })
        : undefined;
      if (includeAuthority && includeDirectory) {
        vi.mocked(admission.admitConfigObservationRoots).mockResolvedValue([
          { authority, boundaries: [directory] },
          { authority: includeAuthority, boundaries: [includeDirectory] },
        ]);
      }
      const candidate =
        reason === "outside pinned roots"
          ? path.resolve(directory, "..", "unadmitted", "include.json")
          : path.join(includeDirectory ?? directory, "a".repeat(256) + ".json");
      if (reason !== "outside pinned roots") {
        const recorded: string[] = [];
        expect(() =>
          resolveConfigIncludes(
            { $include: candidate },
            p("openclaw.json"),
            {
              readFile() {
                throw new Error("unwatchable candidate must fail before content reads");
              },
              parseJson: JSON.parse,
              onLexicalPath: (filename) => recorded.push(filename),
            },
            { allowedRoots: includeDirectory ? [includeDirectory] : [] },
          ),
        ).toThrow(ConfigIncludeReadError);
        // Failed include reads preserve their lexical watch candidates.
        expect(recorded).toEqual([candidate]);
      }
      const h = createHarness([accepted]);
      await h.start();
      h.current().ready();
      await vi.advanceTimersByTimeAsync(0);
      const planned = createDeferred();
      vi.mocked(admission.configObservationScopes).mockImplementation(async (...args) => {
        try {
          return await planConfigScopes(...args);
        } finally {
          if (!includeAuthority || args[0] === includeAuthority) {
            planned.resolve();
          }
        }
      });
      await h.adapter.observePaths([candidate]);
      await planned.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(h.watch).toHaveBeenCalledTimes(2);
      expect(h.current().close).not.toHaveBeenCalled();
      expect(h.current().options.scopes).toEqual([
        { path: "openclaw.json", kind: "entry" },
        { path: "accepted.json", kind: "entry" },
      ]);
      expect(h.watch.mock.calls.every(([admittedRoot]) => admittedRoot === authority)).toBe(true);
      h.current().ready();
      await vi.advanceTimersByTimeAsync(0);
      if (includeDirectory) {
        const retiredParent = dirs.make("config-retired-include-root-");
        await fs.rename(includeDirectory, path.join(retiredParent, "retired"));
      }
      h.onChange.mockClear();
      await h.dirty("openclaw.json");
      await h.dirty("accepted.json");
      expect(h.onChange).toHaveBeenCalledTimes(2);
      sampledOpen.mockClear();
      await h.dirty(undefined, "overflow");
      expect(h.onChange).toHaveBeenCalledTimes(3);
      expect(
        new Set(sampledOpen.mock.calls.map(([relative]) => path.resolve(directory, relative))),
      ).toEqual(new Set([p("openclaw.json"), accepted]));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.watch).toHaveBeenCalledTimes(2);
      expect(h.adapter.status()).toBe("active");
      expect(h.log.error).not.toHaveBeenCalled();
    },
  );

  it("does not silently omit an unwatchable primary config", async () => {
    const h = createHarness([p("accepted.json")], p("a".repeat(256) + ".json"));
    const planned = createDeferred();
    vi.mocked(admission.configObservationScopes).mockImplementation(async (...args) => {
      try {
        return await planConfigScopes(...args);
      } finally {
        planned.resolve();
      }
    });
    h.adapter.start();
    await planned.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.watch).not.toHaveBeenCalled();
    expect(h.onReady).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith(expect.stringContaining("relative path is too long"));
    await h.adapter.stop();
  });

  it("uses automatic backend selection without changing the reconciliation cadence", async () => {
    const h = createHarness();
    await h.start();
    h.current().ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onReady).toHaveBeenCalledOnce();
    expect(h.current().options.mode).toBe("auto");
    expect(h.current().options.intervalMs).toBeUndefined();
  });

  it("forwards the explicit polling cadence", async () => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "TrUe");
    vi.stubEnv("CHOKIDAR_INTERVAL", "250");
    const h = createHarness();
    await h.start();
    expect(h.current().options).toMatchObject({ mode: "poll", intervalMs: 250 });
  });

  it.each([
    { setting: undefined, modes: ["auto", "poll"] },
    { setting: "1", modes: ["poll"] },
    { setting: "TrUe", modes: ["poll"] },
    { setting: "0", modes: ["events", "poll"] },
    { setting: "FALSE", modes: ["events", "poll"] },
  ])("bounds recovery for polling setting $setting", async ({ setting, modes }) => {
    vi.stubEnv("CHOKIDAR_USEPOLLING", setting);
    const h = createHarness();
    await h.start();
    for (const [index, mode] of modes.entries()) {
      for (const delay of [500, 2000, 5000]) {
        expect(h.current().options.mode).toBe(mode);
        const old = h.current();
        old.fail();
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(h.current()).toBe(old);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.current()).not.toBe(old);
        h.current().ready();
        await vi.advanceTimersByTimeAsync(0);
      }
      h.current().fail();
      if (index < modes.length - 1) {
        await vi.advanceTimersByTimeAsync(500);
      }
    }
    expect(h.adapter.status()).toBe("disabled");
    expect(h.log.error).toHaveBeenCalledWith(expect.stringContaining("config hot-reload disabled"));
    const creations = h.watch.mock.calls.length;
    await vi.runAllTimersAsync();
    expect(h.watch).toHaveBeenCalledTimes(creations);
    expect(admission.admitConfigObservationRoots).toHaveBeenCalledOnce();
  });

  it.each(["event", "reconcile"] as const)(
    "resets retries on changed file facts, not whole-scope invalidation (%s)",
    async (reason) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", reason === "reconcile" ? "true" : "false");
      const h = createHarness();
      await h.start();
      for (let round = 0; round < 5; round += 1) {
        h.current().fail();
        await vi.advanceTimersByTimeAsync(500);
        await h.dirty("openclaw.json", reason);
      }
      expect(h.adapter.status()).toBe("active");
      h.current().fail();
      await vi.advanceTimersByTimeAsync(500);
      // Unknown reconciliation here is ongoing coverage, not bootstrap.
      h.current().ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.onChange).toHaveBeenCalledTimes(12);
      await h.dirty(undefined, reason);
      expect(h.onChange).toHaveBeenCalledTimes(13);
      h.current().fail();
      const old = h.current();
      await vi.advanceTimersByTimeAsync(1999);
      expect(h.current()).toBe(old);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.current()).not.toBe(old);
      expect(h.onChange).toHaveBeenCalledTimes(14);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "joins retirement after %s without rearming",
    async (outcome) => {
      const h = createHarness();
      await h.start();
      h.current().ready();
      await vi.advanceTimersByTimeAsync(0);
      const closing = createDeferred();
      h.current().close.mockReturnValue(closing.promise);
      const updating = h.adapter.observePaths([p("next.json5")]);
      const stopped = vi.fn();
      const stopping = h.adapter.stop().then(stopped, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).not.toHaveBeenCalled();
      if (outcome === "reject") {
        closing.reject(new Error("physical close failed"));
      } else {
        closing.resolve();
      }
      await updating;
      const result = await stopping;
      if (outcome === "reject") {
        expect(result).toBeInstanceOf(AggregateError);
      } else {
        expect(stopped).toHaveBeenCalledOnce();
      }
      expect(h.watch).toHaveBeenCalledOnce();
    },
  );
  it("joins and fences a held sample when accepted paths replace its generation", async () => {
    const h = createHarness();
    await h.start();
    h.current().ready();
    await vi.advanceTimersByTimeAsync(0);
    const opened = await open("openclaw.json", { symlinks: "reject" });
    const sample = createDeferred<Awaited<ReturnType<Root["open"]>>>();
    sampledOpen.mockReturnValue(sample.promise);
    h.current().dirty("openclaw.json");
    await vi.advanceTimersByTimeAsync(50);
    expect(sampledOpen).toHaveBeenCalled();
    const finished = vi.fn();
    const replacing = h.adapter.acceptPaths([p("replacement.json5")]).then(finished);
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).not.toHaveBeenCalled();
    sample.resolve(opened);
    await replacing;
    await vi.advanceTimersByTimeAsync(250);
    expect(opened.handle.fd).toBe(-1);
    expect(h.onChange).not.toHaveBeenCalled();
    h.current().ready();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.onChange).toHaveBeenCalledOnce();
  });

  it("does not turn a guarded scan failure into a transport fallback", async () => {
    const h = createHarness();
    await h.start();
    for (const delay of [500, 2000, 5000]) {
      h.current().fail(new Error("Root identity lost"), { operation: "scan" });
      await vi.advanceTimersByTimeAsync(delay);
    }
    h.current().fail(new Error("Root identity lost"), { operation: "scan" });
    await vi.runAllTimersAsync();
    expect(h.adapter.status()).toBe("disabled");
    expect(h.watch.mock.calls.every(([, options]) => options.mode === "auto")).toBe(true);
  });

  it("retries failed initial admission without renewing successful Roots", async () => {
    vi.mocked(admission.admitConfigObservationRoots).mockRejectedValueOnce(
      new Error("temporary admission failure"),
    );
    const h = createHarness();
    await h.start();
    expect(h.watch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.watch).toHaveBeenCalledOnce();
    expect(admission.admitConfigObservationRoots).toHaveBeenCalledTimes(2);
    h.current().ready();
    await vi.advanceTimersByTimeAsync(0);
    h.current().fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.watch).toHaveBeenCalledTimes(2);
    expect(admission.admitConfigObservationRoots).toHaveBeenCalledTimes(2);
    expect(h.watch.mock.calls.every(([admitted]) => admitted === authority)).toBe(true);
  });
});
