import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

function buildConfig(provider: string, allowFrom: string[]): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          [provider]: allowFrom,
        },
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
  provider?: string;
  allowFrom: string[];
  ctx?: Partial<MsgContext>;
  allowed: boolean;
}) {
  const provider = params.provider ?? "whatsapp";
  const result = resolveElevatedPermissions({
    cfg: buildConfig(provider, params.allowFrom),
    agentId: "main",
    provider,
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
    key: `tools.elevated.allowFrom.${provider}`,
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

  it("authorizes mutable sender fields only with explicit prefix", () => {
    expectAllowFromDecision({
      allowFrom: ["username:owner_username"],
      allowed: true,
      ctx: {
        SenderUsername: "owner_username",
      },
    });
  });

  it("authorizes webchat sender ids via plain allowFrom entries", () => {
    expectAllowFromDecision({
      provider: "webchat",
      allowFrom: ["openclaw-control-ui"],
      allowed: true,
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        SenderId: "openclaw-control-ui",
        SenderName: "OpenClaw Control UI",
        SenderUsername: "OpenClaw Control UI",
        From: "webchat:openclaw-control-ui",
        SenderE164: undefined,
      },
    });
  });
});
