// Agent bind Matrix integration tests cover account binding resolution through plugin registry surfaces.
import { afterEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createBindingResolverTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { parseBindingSpecs } from "./agents.bindings.js";

const matrixBindingPlugin = createBindingResolverTestPlugin({
  id: "matrix",
  resolveBindingAccountId: ({ accountId, agentId }) => {
    const explicit = accountId?.trim();
    if (explicit) {
      return explicit;
    }
    const agent = agentId?.trim();
    return agent || "default";
  },
});

describe("agents bind matrix integration", () => {
  it("uses matrix plugin binding resolver when accountId is omitted", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({ agentId: "main", specs: ["matrix"], config: {} });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      { type: "route", agentId: "main", match: { channel: "matrix", accountId: "main" } },
    ]);
  });

  it("accepts a three-segment peer binding spec (channel:peer_kind:peer_id)", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix:group:oc_test"],
      config: {},
    });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "main",
        match: { channel: "matrix", peer: { kind: "group", id: "oc_test" } },
      },
    ]);
  });

  it("rejects a binding spec with more than three colon segments", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix:work:extra:too_many"],
      config: {},
    });

    expect(parsed.bindings).toEqual([]);
    expect(parsed.errors).toEqual([
      'Invalid binding "matrix:work:extra:too_many". Too many segments. Use <channel>:<account> (e.g., telegram:default) or <channel>:<peer_kind>:<peer_id> (e.g., feishu:group:oc_test).',
    ]);
  });

  it("rejects peer binding with invalid peer kind", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix:invalid:oc_test"],
      config: {},
    });

    expect(parsed.bindings).toEqual([]);
    expect(parsed.errors).toEqual([
      'Invalid binding "matrix:invalid:oc_test". Peer kind "invalid" is not valid. Use one of: direct, group, channel. For example feishu:group:oc_test.',
    ]);
  });

  it("rejects peer binding with empty peer kind", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix::oc_test"],
      config: {},
    });

    expect(parsed.bindings).toEqual([]);
    expect(parsed.errors).toEqual([
      'Invalid binding "matrix::oc_test". Peer kind is empty. Use <channel>:<peer_kind>:<peer_id>, for example feishu:group:oc_test.',
    ]);
  });

  it("rejects peer binding with empty peer id", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix:group:"],
      config: {},
    });

    expect(parsed.bindings).toEqual([]);
    expect(parsed.errors).toEqual([
      'Invalid binding "matrix:group:". Peer id is empty. Use <channel>:<peer_kind>:<peer_id>, for example feishu:group:oc_test.',
    ]);
  });

  it("normalizes peer kind aliases (dm -> direct)", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix:dm:user123"],
      config: {},
    });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "main",
        match: { channel: "matrix", peer: { kind: "direct", id: "user123" } },
      },
    ]);
  });

  it("accepts peer binding with channel kind", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({
      agentId: "main",
      specs: ["matrix:channel:news"],
      config: {},
    });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "main",
        match: { channel: "matrix", peer: { kind: "channel", id: "news" } },
      },
    ]);
  });

  it("still accepts a single channel:account binding", () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "matrix", plugin: matrixBindingPlugin, source: "test" }]),
    );

    const parsed = parseBindingSpecs({ agentId: "main", specs: ["matrix:work"], config: {} });

    expect(parsed.errors).toStrictEqual([]);
    expect(parsed.bindings).toEqual([
      { type: "route", agentId: "main", match: { channel: "matrix", accountId: "work" } },
    ]);
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });
});
