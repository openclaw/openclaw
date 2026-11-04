import { afterEach, expect, it, vi } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot as getSnapshot,
  getRuntimeConfigSourceSnapshot as getSource,
  getRuntimeConfigSnapshotMetadata as getMetadata,
  resetConfigRuntimeState,
  resolveRuntimeModelConfigCacheKey as resolveModelKey,
  setRuntimeConfigSnapshot as setSnapshot,
  setRuntimeConfigSourceSnapshotIfCurrent as setSourceIfCurrent,
  setRuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import type { OpenClawConfig as Config } from "./types.openclaw.js";

const unregister: Array<() => void> = [];
const sidebar = (): Config => ({ ui: { prefs: { sidebarEntries: ["sessions"] } } });
const identity = (): Config => ({
  agents: { entries: { main: { identity: { name: "Renamed" } } } },
});
function watchChanges() {
  const changes = vi.fn();
  unregister.push(sessionChanges.subscribe(changes));
  return changes;
}
const modelKey = () => resolveModelKey(getSnapshot()!);

afterEach(() => {
  unregister.splice(0).forEach((release) => release());
  setRuntimeConfigSnapshotRefreshHandler(null);
  resetConfigRuntimeState();
  vi.restoreAllMocks();
});

it.each<[string, Config, string, boolean]>([
  ["sidebar preferences", sidebar(), "config-presentation", false],
  ["agent identity", identity(), "config-profiles", false],
  ["authored sidebar preferences", sidebar(), "config-presentation", true],
  ["authored agent identity", identity(), "config-profiles", true],
])("publishes the projection impact of %s", (_label, change, scope, authored) => {
  const initial: Config = { agents: { entries: { main: {} } } };
  setSnapshot(initial, authored ? structuredClone(initial) : undefined);
  const published = watchChanges();
  const next = { ...initial, ...change };
  setSnapshot(next, authored ? structuredClone(next) : undefined);
  expect(published).toHaveBeenCalledExactlyOnceWith({ all: true, scope });
});

it("reuses publication hashes and model keys across equal mutable fleet clones", () => {
  const entries = Object.fromEntries(
    Array.from({ length: 29 }, (_, index) => [`agent-${index}`, { name: `${index}` }]),
  );
  const base = { agents: { entries } };
  const publications = Array.from({ length: 29 }, () => ({
    config: structuredClone(base),
    source: structuredClone(base),
  }));
  const rosters = new Set<object>(
    publications.flatMap(({ config, source }) => [config.agents.entries, source.agents.entries]),
  );
  const keys = vi.spyOn(Object, "keys");
  const first = publications[0]!;
  setSnapshot(first.config, first.source);
  const metadata = getMetadata();
  const firstModelKey = resolveModelKey(first.config);
  for (const { config, source } of publications.slice(1)) {
    setSnapshot(config, source);
    expect(getMetadata()).toBe(metadata);
    expect(resolveModelKey(getSnapshot()!)).toBe(firstModelKey);
  }
  expect(keys.mock.calls.filter(([value]) => rosters.has(value))).toHaveLength(4);
  expect(getSnapshot()).toBe(first.config);
});

it("keeps non-cloneable and accessor-backed setter inputs on the uncached path", () => {
  const config: Config = { plugins: { entries: { fixture: { config: { value: Symbol("id") } } } } };
  expect(() => setSnapshot(config)).not.toThrow();
  expect(getSnapshot()).toBe(config);
  clearRuntimeConfigSnapshot();
  const port = vi.fn(() => 18789);
  const gateway = Object.defineProperty({}, "port", { get: port, enumerable: true });
  const accessor: Config = { gateway };
  setSnapshot(accessor, accessor);
  expect(port).toHaveBeenCalledTimes(4);
  expect(getSnapshot()).toBe(accessor);
});

it.each(["null prototype", "symbol key"])("preserves %s publication scope", (shape) => {
  const initial: Config = { agents: { entries: { main: {} } } };
  if (shape === "null prototype") {
    Object.setPrototypeOf(initial, null);
  } else {
    Object.assign(initial, { [Symbol("fixture")]: true });
  }
  setSnapshot(initial);
  const changes = watchChanges();
  setSnapshot({ ...initial, ...sidebar() });
  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config-presentation" });
});

it.each(["added", "replaced", "removed"])("authored policy: %s", (change) => {
  const enabled: Config = { plugins: { entries: { fixture: { enabled: true } } } };
  const disabled: Config = { plugins: { entries: { fixture: { enabled: false } } } };
  const initialSource = change === "added" ? undefined : disabled;
  const nextSource = change === "removed" ? undefined : enabled;
  setSnapshot({}, initialSource);
  const before = { revision: getMetadata()!.revision, modelKey: modelKey() };
  const changes = watchChanges();

  setSnapshot({}, nextSource);

  expect(getSource()).toBe(nextSource ?? null);
  expect(getMetadata()!.revision).toBe(before.revision + 1);
  expect(modelKey()).not.toBe(before.modelKey);
  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config-presentation" });
});

it("retains broad authored model-policy invalidation alongside runtime preferences", () => {
  const source: Config = { agents: { defaults: { model: { primary: "openai/first" } } } };
  setSnapshot({}, source);
  const changes = watchChanges();

  setSnapshot(sidebar(), { agents: { defaults: { model: { primary: "openai/second" } } } });

  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
});

it("restores captured authored policy after its live source was edited in place", () => {
  const source: Config = { plugins: { enabled: true } };
  setSnapshot({}, source);
  const changes = watchChanges();
  source.plugins!.enabled = false;
  const restored: Config = { plugins: { enabled: true } };

  setSnapshot({}, restored);

  expect(getSource()).toBe(restored);
  expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
});

it.each(["same source", "equal clone", "migration marker"])("version restamp: %s", (change) => {
  const source: Config = { plugins: { enabled: true }, meta: { lastTouchedVersion: "1" } };
  setSnapshot({}, source);
  const metadata = getMetadata()!;
  const previousModelKey = modelKey();
  const changes = watchChanges();
  source.meta!.lastTouchedVersion = "2";
  if (change === "migration marker") {
    source.meta!.migrations = { modelPolicyAllowlist: true };
  }
  const nextSource = change === "same source" ? source : structuredClone(source);

  const updated = setSourceIfCurrent({
    expectedRevision: metadata.revision,
    sourceConfig: nextSource,
  });
  expect(updated).toBe(true);

  if (change === "migration marker") {
    expect(getSource()).toBe(nextSource);
    expect(modelKey()).not.toBe(previousModelKey);
    expect(changes).toHaveBeenCalledExactlyOnceWith({ all: true, scope: "config" });
  } else {
    expect(getMetadata()).toBe(metadata);
    expect(modelKey()).toBe(previousModelKey);
    expect(changes).not.toHaveBeenCalled();
  }
});
