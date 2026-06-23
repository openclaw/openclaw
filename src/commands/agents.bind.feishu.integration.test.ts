import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createBindingResolverTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { parseBindingSpecs } from "./agents.bindings.js";

const feishuBindingPlugin = createBindingResolverTestPlugin({
  id: "feishu",
  resolveBindingAccountId: () => undefined,
});

describe("agents bind feishu integration", () => {
  it("parses feishu group chat bindings into peer matches", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({ agentId: "main", specs: ["feishu:oc_test"], config: {} });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "main",
        match: { channel: "feishu", peer: { kind: "group", id: "oc_test" } },
      },
    ]);
  });

  it("preserves full feishu topic conversation ids after the channel separator", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "feishu", plugin: feishuBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["feishu:oc_group_chat:topic:om_topic_root"],
      config: {},
    });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "main",
        match: {
          channel: "feishu",
          peer: { kind: "group", id: "oc_group_chat:topic:om_topic_root" },
        },
      },
    ]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });
});
