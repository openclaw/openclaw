import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginManifestRecord } from "../../../plugins/manifest-registry.js";
import { createPluginManifestRecordFixture } from "../../../plugins/plugin-metadata.test-support.js";
import { findContextEnginePluginIdSelector } from "./context-engine-plugin-id-selector.js";

function plugin(
  id: string,
  contextEngineIds?: string[],
  kind: PluginManifestRecord["kind"] = "context-engine",
) {
  return createPluginManifestRecordFixture({ id, contextEngineIds, kind, origin: "global" });
}
const owner = plugin("vendor", ["MiXeD"]);
function find(policy: OpenClawConfig["plugins"] = {}, records = [owner], selector = "vendor") {
  const plugins = {
    entries: { vendor: { enabled: true } },
    ...policy,
    slots: { contextEngine: selector },
  };
  return findContextEnginePluginIdSelector({ plugins }, records);
}

it.each([
  ["Vendor", {}],
  ["vendor", { allow: ["vendor"], entries: {} }],
] satisfies Array<[string, OpenClawConfig["plugins"]]>)(
  "repairs an independently approved %s selector",
  (selector, policy) => {
    expect(find(policy, [owner], selector)).toEqual({
      kind: "replace",
      selector,
      pluginId: "vendor",
      engineId: "MiXeD",
    });
  },
);

it.each([
  ["declared engine", "MiXeD", {}, [owner]],
  ["equal-ID engine", "vendor", {}, [plugin("vendor", ["other"]), plugin("other", ["vendor"])]],
  ["undeclared engine", "vendor", {}, [plugin("vendor")]],
  ["non-engine owner", "vendor", {}, [plugin("vendor", ["MiXeD"], "memory")]],
  ["legacy", "legacy", {}, [plugin("legacy", ["MiXeD"])]],
  ["none", "none", {}, [plugin("none", ["MiXeD"])]],
  ["disabled plugins", "vendor", { enabled: false }, [owner]],
] satisfies Array<[string, string, OpenClawConfig["plugins"], PluginManifestRecord[]]>)(
  "leaves %s unchanged",
  (_name, selector, policy, records) => {
    expect(find(policy, records, selector)).toBeUndefined();
  },
);

const notEnabled = "is not independently enabled";
it.each([
  [
    "multiple engines",
    {},
    [plugin("vendor", ["engine-a", "engine-b"])],
    "set plugins.slots.contextEngine to one of: engine-a, engine-b",
  ],
  [
    "unapproved owner",
    { entries: {} },
    [owner],
    'Enable plugins.entries.vendor or resolve the conflict, then set plugins.slots.contextEngine to "MiXeD"',
  ],
  [
    "case-equal engine outside allowlist",
    { allow: ["other"], entries: {} },
    [plugin("vendor", ["Vendor"])],
    notEnabled,
  ],
  ["enabled owner outside allowlist", { allow: ["other"] }, [owner], notEnabled],
  ["denied owner", { deny: ["vendor"] }, [owner], notEnabled],
  [
    "competing eligible owner",
    { entries: { vendor: { enabled: true }, rival: { enabled: true } } },
    [owner, plugin("rival", ["MiXeD"])],
    "another eligible plugin declares the same engine",
  ],
] satisfies Array<[string, OpenClawConfig["plugins"], PluginManifestRecord[], string]>)(
  "requests a choice for %s",
  (_name, policy, records, message) => {
    const finding = find(policy, records);
    expect(finding).toMatchObject({ kind: "choose", message: expect.stringContaining(message) });
  },
);
