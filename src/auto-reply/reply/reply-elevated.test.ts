import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

function buildConfig(allowFrom: string[]): OpenClawConfig {
  return {
    tools: {
      elevated: {
        allowFrom: {
          whatsapp: allowFrom,
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

describe("resolveElevatedPermissions", () => {
  it("authorizes when sender matches allowFrom", () => {
    const result = resolveElevatedPermissions({
      cfg: buildConfig(["+15550001111"]),
      agentId: "main",
      provider: "whatsapp",
      ctx: buildContext(),
    });

    expect(result.enabled).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("does not authorize when only recipient matches allowFrom", () => {
    const result = resolveElevatedPermissions({
      cfg: buildConfig(["+15559990000"]),
      agentId: "main",
      provider: "whatsapp",
      ctx: buildContext(),
    });

    expect(result.enabled).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.failures).toContainEqual({
      gate: "allowFrom",
      key: "tools.elevated.allowFrom.whatsapp",
    });
  });

  it("does not authorize untyped mutable sender fields", () => {
    const result = resolveElevatedPermissions({
      cfg: buildConfig(["owner-display-name"]),
      agentId: "main",
      provider: "whatsapp",
      ctx: buildContext({
        SenderName: "owner-display-name",
        SenderUsername: "owner-display-name",
        SenderTag: "owner-display-name",
      }),
    });

    expect(result.enabled).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.failures).toContainEqual({
      gate: "allowFrom",
      key: "tools.elevated.allowFrom.whatsapp",
    });
  });

  it("authorizes mutable sender fields only with explicit prefix", () => {
    const result = resolveElevatedPermissions({
      cfg: buildConfig(["username:owner_username"]),
      agentId: "main",
      provider: "whatsapp",
      ctx: buildContext({
        SenderUsername: "owner_username",
      }),
    });

    expect(result.enabled).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });
});
