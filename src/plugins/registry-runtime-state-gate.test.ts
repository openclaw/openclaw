// Regression test: plugins the user installed themselves (global/workspace
// origins) — including plugins generated locally by OpenClaw's plugin-generation
// flow — must be able to use api.runtime.state (openKeyedStore /
// openSyncKeyedStore / openChannelIngressQueue). Previously the trust gate only
// permitted `origin === "bundled"` or `trustedOfficialInstall === true`, which
// blocked every user-installed/generated plugin and crashed their register().
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRuntime } from "./runtime/index.js";

vi.mock("../plugin-state/plugin-state-store.js", () => ({
  createPluginStateKeyedStore: vi.fn(() => ({ kind: "keyed" })),
  createPluginStateSyncKeyedStore: vi.fn(() => ({ kind: "sync-keyed" })),
}));

function buildApiForOrigin(origin: PluginOrigin, trustedOfficialInstall = false) {
  const pluginRoot = path.join(os.tmpdir(), "openclaw-plugins", `state-gate-${origin}`);
  const registry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "state-plugin",
    name: "State Plugin",
    source: path.join(pluginRoot, "index.js"),
    rootDir: pluginRoot,
    origin,
    trustedOfficialInstall,
    enabled: true,
    configSchema: false,
  });
  return registry.createApi(record, { config: {} as OpenClawConfig });
}

const openStore = (api: ReturnType<typeof buildApiForOrigin>) =>
  api.runtime.state.openSyncKeyedStore({
    namespace: "demo",
    maxEntries: 10,
    overflowPolicy: "reject-new",
  });

describe("plugin runtime state trust gate", () => {
  it("allows user-installed (global) plugins to use api.runtime.state", () => {
    const api = buildApiForOrigin("global");
    expect(() => openStore(api)).not.toThrow();
  });

  it("allows user-installed (workspace) plugins to use api.runtime.state", () => {
    const api = buildApiForOrigin("workspace");
    expect(() => openStore(api)).not.toThrow();
  });

  it("still allows bundled plugins", () => {
    const api = buildApiForOrigin("bundled");
    expect(() => openStore(api)).not.toThrow();
  });

  it("still allows trusted official installs", () => {
    const api = buildApiForOrigin("global", true);
    expect(() => openStore(api)).not.toThrow();
  });
});
