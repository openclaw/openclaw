import { afterEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
  resetConfigRuntimeState,
  resolveRuntimeModelConfigCacheKey,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { OpenClawConfig } from "./types.openclaw.js";

const unregister: Array<() => void> = [];

afterEach(() => {
  unregister.splice(0).forEach((release) => release());
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
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
