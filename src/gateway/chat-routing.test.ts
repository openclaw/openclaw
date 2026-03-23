import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildDirectedAgentBodyForAgent,
  parseDirectedAgentPrefix,
  resolveAgentAliasToCanonicalId,
  resolveDirectedAgentRequest,
  resolveGatewayChatOrchestrationPolicy,
} from "./chat-routing.js";

describe("gateway chat routing", () => {
  it("parses @agent prefixes", () => {
    expect(parseDirectedAgentPrefix("@legal review this contract")).toEqual({
      alias: "legal",
      strippedMessage: "review this contract",
      originalMessage: "@legal review this contract",
    });
  });

  it("resolves aliases from config", () => {
    const cfg: OpenClawConfig = {
      agents: {
        orchestration: {
          routingAliases: [{ agentId: "rail-business", aliases: ["rail", "wagon", "wagons"] }],
        },
      },
    };
    expect(resolveAgentAliasToCanonicalId("wagon", cfg)).toBe("rail-business");
    expect(resolveAgentAliasToCanonicalId("rail-business", cfg)).toBe("rail-business");
  });

  it("falls back safely when alias is unknown", () => {
    const cfg: OpenClawConfig = {};
    expect(
      resolveDirectedAgentRequest({
        message: "@unknown please help",
        currentAgentId: "main",
        defaultAgentId: "main",
        cfg,
      }),
    ).toBeNull();
  });

  it("uses backward-compatible defaults when config is absent", () => {
    const cfg: OpenClawConfig = {};
    expect(resolveAgentAliasToCanonicalId("rail", cfg)).toBe("trk");
    expect(resolveAgentAliasToCanonicalId("automation", cfg)).toBe("auto");
    expect(resolveGatewayChatOrchestrationPolicy(cfg)).toMatchObject({
      defaultBehavior: "orchestrate",
      fallbackBehavior: "self-answer",
      directRoutingMode: "hint",
      allowMultiAgentDelegation: true,
      preserveUserVisibleSingleChat: true,
    });
  });

  it("resolves directed routing only on the main orchestrator path", () => {
    const cfg: OpenClawConfig = {};
    expect(
      resolveDirectedAgentRequest({
        message: "@legal review this",
        currentAgentId: "main",
        defaultAgentId: "main",
        cfg,
      }),
    ).toEqual({ targetAgentId: "legal", strippedMessage: "review this" });

    expect(
      resolveDirectedAgentRequest({
        message: "@legal review this",
        currentAgentId: "legal",
        defaultAgentId: "main",
        cfg,
      }),
    ).toBeNull();
  });

  it("uses policy to build a force-routing directive", () => {
    const cfg: OpenClawConfig = {
      agents: {
        orchestration: {
          policy: {
            directRoutingMode: "force",
            allowMultiAgentDelegation: false,
          },
        },
      },
    };
    const body = buildDirectedAgentBodyForAgent({
      targetAgentId: "legal",
      strippedMessage: "review this",
      originalMessage: "@legal review this",
      cfg,
    });
    expect(body).toContain("Treat this as an explicit routing directive");
    expect(body).toContain("avoid unnecessary multi-agent fan-out");
  });
});
