import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginLoader from "../plugins/loader.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { resolveGatewayScopedTools } from "./tool-resolution.js";

// The manifest snapshot owns one bundled plugin declaring a single tool. Tool
// resolution derives the plugin cold-load set from its allowlist, so whether
// `loadPluginRegistryHandle` is reached is observable construction cost.
const snapshotFixture = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "probe-plugin", contracts: { tools: ["probe_tool"] } }],
});

const registryLoads = vi.hoisted(() => vi.fn());

vi.mock("../plugins/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/loader.js")>()),
  loadPluginRegistryHandle: (...args: Parameters<typeof pluginLoader.loadPluginRegistryHandle>) =>
    registryLoads(...args),
}));

vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>()),
  loadManifestContractSnapshot: () => ({
    index: snapshotFixture.index,
    plugins: snapshotFixture.plugins,
    byPluginId: snapshotFixture.byPluginId,
  }),
}));

const cfg: OpenClawConfig = {
  plugins: {
    allow: ["probe-plugin"],
    entries: { "probe-plugin": { enabled: true } },
  },
};
const workspaceDir = path.join(os.tmpdir(), "tool-resolution-construction-cap");

async function resolveLoopback(
  overrides: Partial<Parameters<typeof resolveGatewayScopedTools>[0]>,
) {
  return await resolveGatewayScopedTools({
    cfg,
    sessionKey: "agent:main:main",
    surface: "loopback",
    senderIsOwner: true,
    workspaceDir,
    ...overrides,
  });
}

const toolNames = (result: { tools: { name: string }[] }) => result.tools.map(({ name }) => name);

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  registryLoads.mockReset().mockImplementation(() => createEmptyPluginRegistry());
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("loopback construction cap", () => {
  it("skips plugin registry construction when the exact grant cannot reach plugin tools", async () => {
    const result = await resolveLoopback({
      constructionToolsAllow: ["tool_describe", "dispatch_action"],
    });
    expect(registryLoads).not.toHaveBeenCalled();
    expect(toolNames(result)).not.toContain("probe_tool");
  });

  it("still loads a plugin the exact grant names", async () => {
    await resolveLoopback({ constructionToolsAllow: ["probe_tool", "tool_describe"] });
    expect(registryLoads).toHaveBeenCalledTimes(1);
    expect(registryLoads.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["probe-plugin"]);
  });

  it("keeps uncapped loopback construction on the existing full-load path", async () => {
    await resolveLoopback({});
    expect(registryLoads).toHaveBeenCalledTimes(1);
    expect(registryLoads.mock.calls[0]?.[0]?.onlyPluginIds).toEqual(["probe-plugin"]);
  });
});
