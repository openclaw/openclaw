import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

function buildConfig(
  allowFrom: string[],
  opts?: { dangerouslyAllowMutableMatching?: boolean },
): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          whatsapp: allowFrom,
        },
        dangerouslyAllowMutableMatching: opts?.dangerouslyAllowMutableMatching,
      },
    },
  } as OpenClawConfig;
}

function buildContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    Provider: "whatsapp",
    Surface: "whatsapp",
    SenderId: "+15550001111",
    From: "whatsapp:+15550001111",
    SenderE164: "+15550001111",
    To: "+15559990000",
    ...overrides,
  } as MsgContext;
}

function expectAllowFromDecision(params: {
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
  dangerouslyAllowMutableMatching?: boolean;
}) {
  const result = resolveElevatedPermissions({
    cfg: buildConfig(params.allowFrom, {
      dangerouslyAllowMutableMatching: params.dangerouslyAllowMutableMatching,
    }),
    agentId: "main",
    provider: "whatsapp",
    ctx: buildContext(params.ctx),
  });

  expect(result.enabled).toBe(true);
  expect(result.allowed).toBe(params.allowed);
  if (params.allowed) {
    expect(result.failures).toHaveLength(0);
    return;
  }

  expect(result.failures).toContainEqual({
    gate: "allowFrom",
    key: "tools.elevated.allowFrom.whatsapp",
  });
}

describe("resolveElevatedPermissions", () => {
  it("authorizes when sender matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15550001111"],
      allowed: true,
    });
  });

  it("does not authorize when only recipient matches allowFrom", () => {
    expectAllowFromDecision({
      allowFrom: ["+15559990000"],
      allowed: false,
    });
  });

  it("does not authorize untyped mutable sender fields", () => {
    expectAllowFromDecision({
      allowFrom: ["owner-display-name"],
      allowed: false,
      ctx: {
        SenderName: "owner-display-name",
        SenderUsername: "owner-display-name",
        SenderTag: "owner-display-name",
      },
    });
  });

  describe("mutable identity spoofing protection", () => {
    it("rejects name: matcher without dangerouslyAllowMutableMatching (fail-closed)", () => {
      expectAllowFromDecision({
        allowFrom: ["name:Alice"],
        allowed: false,
        ctx: { SenderName: "Alice" },
      });
    });

    it("rejects username: matcher without dangerouslyAllowMutableMatching (fail-closed)", () => {
      expectAllowFromDecision({
        allowFrom: ["username:owner_username"],
        allowed: false,
        ctx: { SenderUsername: "owner_username" },
      });
    });

    it("rejects tag: matcher without dangerouslyAllowMutableMatching (fail-closed)", () => {
      expectAllowFromDecision({
        allowFrom: ["tag:Owner#1234"],
        allowed: false,
        ctx: { SenderTag: "Owner#1234" },
      });
    });

    it("allows name: matcher when dangerouslyAllowMutableMatching is true", () => {
      expectAllowFromDecision({
        allowFrom: ["name:Alice"],
        allowed: true,
        dangerouslyAllowMutableMatching: true,
        ctx: { SenderName: "Alice" },
      });
    });

    it("allows username: matcher when dangerouslyAllowMutableMatching is true", () => {
      expectAllowFromDecision({
        allowFrom: ["username:owner_username"],
        allowed: true,
        dangerouslyAllowMutableMatching: true,
        ctx: { SenderUsername: "owner_username" },
      });
    });

    it("allows tag: matcher when dangerouslyAllowMutableMatching is true", () => {
      expectAllowFromDecision({
        allowFrom: ["tag:Owner#1234"],
        allowed: true,
        dangerouslyAllowMutableMatching: true,
        ctx: { SenderTag: "Owner#1234" },
      });
    });

    it("still authorizes immutable id: matcher without opt-in", () => {
      expectAllowFromDecision({
        allowFrom: ["id:+15550001111"],
        allowed: true,
        ctx: { SenderId: "+15550001111" },
      });
    });

    it("still authorizes immutable e164: matcher without opt-in", () => {
      expectAllowFromDecision({
        allowFrom: ["e164:+15550001111"],
        allowed: true,
        ctx: { SenderE164: "+15550001111" },
      });
    });
  });
});
