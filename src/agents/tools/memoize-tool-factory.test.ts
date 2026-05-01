import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMemoToolFactoryCacheForTesting,
  memoizeToolFactory,
} from "./memoize-tool-factory.js";

describe("memoizeToolFactory", () => {
  beforeEach(() => {
    __resetMemoToolFactoryCacheForTesting();
  });

  it("returns the same instance on repeated calls with identical refs and scalars", () => {
    const cfg = {};
    const factory = vi.fn(() => ({ token: Symbol("a") }));

    const first = memoizeToolFactory({
      label: "fixture",
      refs: [cfg],
      scalars: ["x"],
      factory,
    });
    const second = memoizeToolFactory({
      label: "fixture",
      refs: [cfg],
      scalars: ["x"],
      factory,
    });

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("invalidates when any object ref identity changes (config reload)", () => {
    const cfgA = {};
    const cfgB = {};
    const factory = vi.fn(() => ({ token: Symbol("v") }));

    const a = memoizeToolFactory({
      label: "fixture",
      refs: [cfgA],
      scalars: [],
      factory,
    });
    const b = memoizeToolFactory({
      label: "fixture",
      refs: [cfgB],
      scalars: [],
      factory,
    });

    expect(b).not.toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidates when runtime metadata ref swaps (web tools provider change)", () => {
    const cfg = {};
    const runtimeA = { search: { selectedProvider: "alpha" } };
    const runtimeB = { search: { selectedProvider: "beta" } };
    const factory = vi.fn((mark: string) => ({ mark }));

    const first = memoizeToolFactory({
      label: "createWebSearchTool",
      refs: [cfg, runtimeA],
      scalars: [false],
      factory: () => factory("a"),
    });
    const second = memoizeToolFactory({
      label: "createWebSearchTool",
      refs: [cfg, runtimeB],
      scalars: [false],
      factory: () => factory("b"),
    });

    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidates when sandboxFsBridge identity swaps", () => {
    const cfg = {};
    const bridgeA = { id: "bridge-a" };
    const bridgeB = { id: "bridge-b" };
    const factory = vi.fn(() => ({ instance: Symbol("tool") }));

    const a = memoizeToolFactory({
      label: "createImageTool",
      refs: [cfg, bridgeA],
      scalars: ["/agent", "/ws", "/sandbox", false, true],
      factory,
    });
    const b = memoizeToolFactory({
      label: "createImageTool",
      refs: [cfg, bridgeB],
      scalars: ["/agent", "/ws", "/sandbox", false, true],
      factory,
    });

    expect(b).not.toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidates when fsPolicy.workspaceOnly toggles (scalar key)", () => {
    const cfg = {};
    const factory = vi.fn(() => ({ instance: Symbol("tool") }));

    const open = memoizeToolFactory({
      label: "createPdfTool",
      refs: [cfg, undefined],
      scalars: ["/agent", "/ws", null, /* workspaceOnly */ false],
      factory,
    });
    const locked = memoizeToolFactory({
      label: "createPdfTool",
      refs: [cfg, undefined],
      scalars: ["/agent", "/ws", null, /* workspaceOnly */ true],
      factory,
    });

    expect(locked).not.toBe(open);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("invalidates video/music when delivery context scalars change (channel/to/account/thread)", () => {
    const cfg = {};
    const factory = vi.fn(() => ({ instance: Symbol("video") }));

    const slack = memoizeToolFactory({
      label: "createVideoGenerateTool",
      refs: [cfg, undefined],
      scalars: [
        "/agent",
        "session-1",
        "/ws",
        null,
        false,
        /* channel */ "slack",
        /* to */ "C123",
        /* account */ "team-a",
        /* thread */ "1700000000.0001",
      ],
      factory,
    });
    const telegram = memoizeToolFactory({
      label: "createVideoGenerateTool",
      refs: [cfg, undefined],
      scalars: [
        "/agent",
        "session-1",
        "/ws",
        null,
        false,
        /* channel */ "telegram",
        /* to */ "777",
        /* account */ "default",
        /* thread */ null,
      ],
      factory,
    });

    expect(telegram).not.toBe(slack);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("returns distinct entries per label even when refs and scalars match", () => {
    const cfg = {};
    const factory = vi.fn(() => ({ instance: Symbol("x") }));

    const search = memoizeToolFactory({
      label: "createWebSearchTool",
      refs: [cfg],
      scalars: [false],
      factory,
    });
    const fetch = memoizeToolFactory({
      label: "createWebFetchTool",
      refs: [cfg],
      scalars: [false],
      factory,
    });

    expect(fetch).not.toBe(search);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("buckets nullish refs into a shared sentinel", () => {
    const factory = vi.fn(() => ({ instance: Symbol("y") }));

    const undef = memoizeToolFactory({
      label: "fixture",
      refs: [undefined, undefined],
      scalars: ["q"],
      factory,
    });
    const explicitNull = memoizeToolFactory({
      label: "fixture",
      refs: [null, null],
      scalars: ["q"],
      factory,
    });

    expect(explicitNull).toBe(undef);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("supports empty refs (anchors on sentinel) but still distinguishes scalars", () => {
    const factory = vi.fn((tag: string) => ({ tag }));

    const a = memoizeToolFactory({
      label: "fixture",
      refs: [],
      scalars: ["a"],
      factory: () => factory("a"),
    });
    const b = memoizeToolFactory({
      label: "fixture",
      refs: [],
      scalars: ["b"],
      factory: () => factory("b"),
    });
    const aAgain = memoizeToolFactory({
      label: "fixture",
      refs: [],
      scalars: ["a"],
      factory: () => factory("a-again"),
    });

    expect(a).not.toBe(b);
    expect(aAgain).toBe(a);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("does not call the factory once a value is cached", () => {
    const cfg = {};
    const calls = { n: 0 };
    const factory = () => {
      calls.n++;
      return { instance: Symbol("z") };
    };

    for (let i = 0; i < 50; i++) {
      memoizeToolFactory({
        label: "fixture",
        refs: [cfg],
        scalars: ["k"],
        factory,
      });
    }
    expect(calls.n).toBe(1);
  });
});
