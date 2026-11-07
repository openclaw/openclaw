import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runPluginMarketplaceListCommand as list } from "./plugins-marketplace-list-command.js";

// mock-isolation: Marketplace list command tests isolate runtime reads from operator state.
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));
// mock-isolation: Marketplace list command tests isolate the plugin read from network state.
vi.mock("../plugins/marketplace.js", () => ({
  listMarketplacePlugins: mocks.listMarketplacePlugins,
}));

const mocks = vi.hoisted(() => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    log: vi.fn(),
    writeJson: vi.fn(),
  },
  listMarketplacePlugins: vi.fn(),
}));

const runtime = mocks.defaultRuntime;
const source = "owner/repo";
const manifest = {
  name: "QA Marketplace",
  version: "1.0.0",
  plugins: [
    ["numeric", "1.2.3"],
    ["prefixed", "v1.2.3"],
    ["missing", undefined],
  ].map(([name, version]) => ({
    name,
    version,
    source: { kind: "path", path: "./plugins/demo" },
  })),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMarketplacePlugins.mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("plugins marketplace list command", () => {
  it.each(["before", "result"] as const)("cancels the marketplace list read: %s", async (mode) => {
    const scope = new AsyncWorkScope();
    mocks.listMarketplacePlugins.mockImplementation(() => {
      scope.beginClose();
      return Promise.resolve({ ok: true as const, sourceLabel: source, manifest });
    });
    if (mode === "before") {
      scope.beginClose();
    }
    await scope.run(() => list(source, { json: true }));
    expect(mocks.listMarketplacePlugins).toHaveBeenCalledTimes(mode === "before" ? 0 : 1);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
