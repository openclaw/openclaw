import { afterEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  getRuntimeConfigSnapshotMetadata,
  resetConfigRuntimeState,
  resolveRuntimeModelConfigCacheKey,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const unregister: Array<() => void> = [];

afterEach(() => {
  unregister.splice(0).forEach((release) => release());
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
});

it.each<[string, OpenClawConfig, string, boolean]>([
  [
    "sidebar preferences",
    { ui: { prefs: { sidebarEntries: ["sessions"] } } },
    "config-presentation",
    false,
  ],
  [
    "agent identity",
    { agents: { entries: { main: { identity: { name: "Renamed" } } } } },
    "config-profiles",
    false,
  ],
  [
    "authored sidebar preferences",
    { ui: { prefs: { sidebarEntries: ["sessions"] } } },
    "config-presentation",
    true,
  ],
  [
    "authored agent identity",
    { agents: { entries: { main: { identity: { name: "Renamed" } } } } },
    "config-profiles",
    true,
  ],
])("publishes the projection impact of %s", (_label, change, scope, authored) => {
  const initial: OpenClawConfig = { agents: { entries: { main: {} } } };
  setRuntimeConfigSnapshot(initial, authored ? structuredClone(initial) : undefined);
  const published = vi.fn();
  const stop = sessionChanges.subscribe(published);
  try {
    const next = { ...initial, ...change };
    setRuntimeConfigSnapshot(next, authored ? structuredClone(next) : undefined);
    expect(published).toHaveBeenCalledExactlyOnceWith({ all: true, scope });
  } finally {
    stop();
  }
});

it("reuses publication hashes and model keys across equal mutable fleet clones", () => {
  const base = {
    agents: {
      entries: Object.fromEntries(
        Array.from({ length: 29 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
      ),
    },
  };
  const publications = Array.from({ length: 29 }, () => ({
    config: structuredClone(base),
    source: structuredClone(base),
  }));
  const rosters = new Set<object>(
    publications.flatMap(({ config, source }) => [config.agents.entries, source.agents.entries]),
  );
  const keys = vi.spyOn(Object, "keys");
  try {
    const first = publications[0]!;
    setRuntimeConfigSnapshot(first.config, first.source);
    const metadata = getRuntimeConfigSnapshotMetadata();
    const modelKey = resolveRuntimeModelConfigCacheKey(first.config);
    for (const { config, source } of publications.slice(1)) {
      setRuntimeConfigSnapshot(config, source);
      expect(getRuntimeConfigSnapshotMetadata()).toBe(metadata);
      expect(resolveRuntimeModelConfigCacheKey(getRuntimeConfigSnapshot()!)).toBe(modelKey);
    }
    expect(keys.mock.calls.filter(([value]) => rosters.has(value))).toHaveLength(4);
    expect(getRuntimeConfigSnapshot()).toBe(first.config);
  } finally {
    keys.mockRestore();
  }
});

it("keeps non-cloneable and accessor-backed setter inputs on the uncached path", () => {
  const config: OpenClawConfig = {
    plugins: { entries: { fixture: { config: { value: Symbol("fixture") } } } },
  };
  expect(() => setRuntimeConfigSnapshot(config)).not.toThrow();
  expect(getRuntimeConfigSnapshot()).toBe(config);
  clearRuntimeConfigSnapshot();
  const port = vi.fn(() => 18789);
  const accessor: OpenClawConfig = {
    gateway: Object.defineProperty({}, "port", {
      get: port,
      enumerable: true,
    }),
  };
  setRuntimeConfigSnapshot(accessor, accessor);
  expect(port).toHaveBeenCalledTimes(4);
  expect(getRuntimeConfigSnapshot()).toBe(accessor);
});

it.each(["null prototype", "symbol key"])(
  "preserves publication scope for inputs with a %s",
  (shape) => {
    const initial: OpenClawConfig = { agents: { entries: { main: {} } } };
    if (shape === "null prototype") {
      Object.setPrototypeOf(initial, null);
    } else {
      Object.assign(initial, { [Symbol("fixture")]: true });
    }
    setRuntimeConfigSnapshot(initial);
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));
    setRuntimeConfigSnapshot({
      ...initial,
      ui: { prefs: { sidebarEntries: ["sessions"] } },
    });
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config-presentation" });
  },
);

it.each(["added", "replaced", "removed"])(
  "publishes %s authored policy when runtime values are unchanged",
  (change) => {
    const enabled: OpenClawConfig = { plugins: { entries: { fixture: { enabled: true } } } };
    const disabled: OpenClawConfig = { plugins: { entries: { fixture: { enabled: false } } } };
    const initialSource = change === "added" ? undefined : disabled;
    const nextSource = change === "removed" ? undefined : enabled;
    setRuntimeConfigSnapshot({}, initialSource);
    const previousRevision = getRuntimeConfigSnapshotMetadata()!.revision;
    const previousModelKey = resolveRuntimeModelConfigCacheKey(getRuntimeConfigSnapshot()!);
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));

    setRuntimeConfigSnapshot({}, nextSource);

    expect(getRuntimeConfigSourceSnapshot()).toBe(nextSource ?? null);
    expect(getRuntimeConfigSnapshotMetadata()!.revision).toBe(previousRevision + 1);
    expect(resolveRuntimeModelConfigCacheKey(getRuntimeConfigSnapshot()!)).not.toBe(
      previousModelKey,
    );
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config-presentation" });
  },
);

it("retains broad authored model-policy invalidation alongside runtime preferences", () => {
  const source: OpenClawConfig = {
    agents: { defaults: { model: { primary: "openai/first" } } },
  };
  setRuntimeConfigSnapshot({}, source);
  const changes = vi.fn();
  unregister.push(sessionChanges.subscribe(changes));

  setRuntimeConfigSnapshot(
    { ui: { prefs: { sidebarEntries: ["sessions"] } } },
    { agents: { defaults: { model: { primary: "openai/second" } } } },
  );

  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
});

it("restores captured authored policy after its live source was edited in place", () => {
  const source: OpenClawConfig = { plugins: { enabled: true } };
  setRuntimeConfigSnapshot({}, source);
  const changes = vi.fn();
  unregister.push(sessionChanges.subscribe(changes));
  source.plugins!.enabled = false;
  const restored: OpenClawConfig = { plugins: { enabled: true } };

  setRuntimeConfigSnapshot({}, restored);

  expect(getRuntimeConfigSourceSnapshot()).toBe(restored);
  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
});

it.each(["same source", "equal clone", "migration marker"])(
  "ignores an in-place version restamp while retaining %s policy",
  (change) => {
    const source: OpenClawConfig = {
      plugins: { enabled: true },
      meta: { lastTouchedVersion: "1" },
    };
    setRuntimeConfigSnapshot({}, source);
    const metadata = getRuntimeConfigSnapshotMetadata()!;
    const modelKey = resolveRuntimeModelConfigCacheKey(getRuntimeConfigSnapshot()!);
    const changes = vi.fn();
    unregister.push(sessionChanges.subscribe(changes));
    source.meta!.lastTouchedVersion = "2";
    if (change === "migration marker") {
      source.meta!.migrations = { modelPolicyAllowlist: true };
    }
    const nextSource = change === "same source" ? source : structuredClone(source);

    expect(
      setRuntimeConfigSourceSnapshotIfCurrent({
        expectedRevision: metadata.revision,
        sourceConfig: nextSource,
      }),
    ).toBe(true);

    if (change === "migration marker") {
      expect(getRuntimeConfigSourceSnapshot()).toBe(nextSource);
      expect(resolveRuntimeModelConfigCacheKey(getRuntimeConfigSnapshot()!)).not.toBe(modelKey);
      expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
    } else {
      expect(getRuntimeConfigSnapshotMetadata()).toBe(metadata);
      expect(resolveRuntimeModelConfigCacheKey(getRuntimeConfigSnapshot()!)).toBe(modelKey);
      expect(changes).not.toHaveBeenCalled();
    }
  },
);
