import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildDirectedAgentBodyForAgent,
  resolveAgentAlias,
  resolveAgentOrchestrationPolicy,
  resolveConfiguredRoutingAliases,
  resolveDirectedAgentRequest,
} from "./chat-routing.js";

function makeCfg(): OpenClawConfig {
  return {
    agents: {
      list: [
        { id: "main", default: true, name: "Main" },
        { id: "legal", name: "Legal" },
        { id: "design", name: "Design" },
        { id: "trk", name: "Rail Business" },
        { id: "auto", name: "Automation" },
      ],
      orchestration: {
        routingAliases: [
          { agentId: "legal", aliases: ["legal", "law"] },
          { agentId: "design", aliases: ["design", "brand"] },
          { agentId: "trk", aliases: ["rail", "wagon"] },
          { agentId: "auto", aliases: ["automation", "workflow"] },
          { agentId: "main", aliases: ["main"] },
        ],
        policy: {
          defaultBehavior: "orchestrate",
          fallbackBehavior: "self-answer",
          directRoutingMode: "hint",
          allowMultiAgentDelegation: true,
          preserveUserVisibleSingleChat: true,
        },
      },
    },
  };
}

describe("chat routing helpers", () => {
  it("resolves aliases from config", () => {
    const cfg = makeCfg();
    expect(resolveAgentAlias(cfg, "law")?.agentId).toBe("legal");
    expect(resolveAgentAlias(cfg, "rail")?.agentId).toBe("trk");
  });

  it("parses @agent prefixes only for the default agent path", () => {
    const cfg = makeCfg();
    expect(
      resolveDirectedAgentRequest({
        cfg,
        message: "@legal review the claim",
        currentAgentId: "main",
        defaultAgentId: "main",
      }),
    ).toMatchObject({ targetAgentId: "legal", strippedMessage: "review the claim" });

    expect(
      resolveDirectedAgentRequest({
        cfg,
        message: "@legal review the claim",
        currentAgentId: "legal",
        defaultAgentId: "main",
      }),
    ).toBeNull();
  });

  it("falls back safely when alias is unknown", () => {
    const cfg = makeCfg();
    expect(
      resolveDirectedAgentRequest({
        cfg,
        message: "@unknown do something",
        currentAgentId: "main",
        defaultAgentId: "main",
      }),
    ).toBeNull();
  });

  it("keeps backward-compatible defaults when orchestration config is missing", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [
          { id: "main", default: true, name: "Main" },
          { id: "trk", name: "Rail Business" },
        ],
      },
    };
    expect(resolveAgentOrchestrationPolicy(cfg)).toMatchObject({
      defaultBehavior: "orchestrate",
      fallbackBehavior: "self-answer",
      directRoutingMode: "hint",
    });
    expect(
      resolveConfiguredRoutingAliases(cfg).find((entry) => entry.agentId === "trk")?.aliases,
    ).toContain("rail");
  });

  it("builds a direct routing body without changing single-chat semantics", () => {
    const text = buildDirectedAgentBodyForAgent({
      targetAgentId: "design",
      strippedMessage: "make packaging direction",
      originalMessage: "@design make packaging direction",
      alias: "design",
      mode: "hint",
    });
    expect(text).toContain("[Direct routing request]");
    expect(text).toContain("Target specialist: design");
    expect(text).toContain("[Original user message]");
  });
});
