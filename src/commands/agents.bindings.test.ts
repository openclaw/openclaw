// Agents bindings tests cover parsing and building channel route bindings.
import { describe, expect, it } from "vitest";
import { buildChannelBindings, parseBindingSpecs } from "./agents.bindings.js";

describe("parseBindingSpecs", () => {
  it("parses feishu group binding as peer format", () => {
    const parsed = parseBindingSpecs({
      agentId: "feishu-agent",
      specs: ["feishu:oc_test"],
      config: {},
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "feishu-agent",
        match: {
          channel: "feishu",
          peer: { kind: "group", id: "oc_test" },
        },
      },
    ]);
  });

  it("parses feishu explicit accountId syntax", () => {
    const parsed = parseBindingSpecs({
      agentId: "feishu-agent",
      specs: ["feishu:account:work"],
      config: {},
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.bindings).toEqual([
      {
        type: "route",
        agentId: "feishu-agent",
        match: {
          channel: "feishu",
          accountId: "work",
        },
      },
    ]);
  });

  it("rejects invalid binding with too many colons", () => {
    const parsed = parseBindingSpecs({
      agentId: "agent",
      specs: ["feishu:oc_test:extra:segments"],
      config: {},
    });

    expect(parsed.bindings).toEqual([]);
    expect(parsed.errors).toEqual([
      'Invalid binding "feishu:oc_test:extra:segments". Too many colon-separated segments. Use <channel>:<id> or <channel>:account:<id>.',
    ]);
  });

  it("parses telegram binding as accountId (existing behavior)", () => {
    const parsed = parseBindingSpecs({
      agentId: "telegram-agent",
      specs: ["telegram:default"],
      config: {},
    });

    expect(parsed.errors).toEqual([]);
    // Telegram uses accountId by default
    expect(parsed.bindings[0]?.match.accountId).toBe("default");
    expect(parsed.bindings[0]?.match.peer).toBeUndefined();
  });
});

describe("buildChannelBindings", () => {
  it("builds feishu group binding as peer format", () => {
    const bindings = buildChannelBindings({
      agentId: "feishu-agent",
      selection: ["feishu"],
      config: {},
      accountIds: { feishu: "oc_test" },
    });

    expect(bindings).toEqual([
      {
        type: "route",
        agentId: "feishu-agent",
        match: {
          channel: "feishu",
          peer: { kind: "group", id: "oc_test" },
        },
      },
    ]);
  });

  it("builds feishu explicit accountId binding", () => {
    const bindings = buildChannelBindings({
      agentId: "feishu-agent",
      selection: ["feishu"],
      config: {},
      accountIds: { feishu: "account:work" },
    });

    expect(bindings).toEqual([
      {
        type: "route",
        agentId: "feishu-agent",
        match: {
          channel: "feishu",
          accountId: "work",
        },
      },
    ]);
  });

  it("builds telegram binding as accountId (existing behavior)", () => {
    const bindings = buildChannelBindings({
      agentId: "telegram-agent",
      selection: ["telegram"],
      config: {},
      accountIds: { telegram: "default" },
    });

    expect(bindings).toEqual([
      {
        type: "route",
        agentId: "telegram-agent",
        match: {
          channel: "telegram",
          accountId: "default",
        },
      },
    ]);
  });
});
