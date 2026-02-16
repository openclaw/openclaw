import { describe, expect, it } from "vitest";
import type { MsgContext } from "../templating.js";
import { resolveElevatedPermissions } from "./reply-elevated.js";

describe("elevatedDefault fallback (#18177)", () => {
  it("resolvedElevatedLevel falls back to 'off' when elevatedDefault is not configured", async () => {
    // When tools.elevated.enabled is true and allowFrom matches,
    // resolveElevatedPermissions returns allowed=true.
    // The resolvedElevatedLevel fallback chain in resolveReplyDirectives
    // must end with "off", not "on".
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const source = await fs.readFile(
      path.join(import.meta.dirname, "get-reply-directives.ts"),
      "utf-8",
    );

    const elevatedBlock = source.match(/const resolvedElevatedLevel[\s\S]*?:\s*"off"/);
    expect(elevatedBlock).not.toBeNull();

    const fallbackMatch = elevatedBlock![0].match(/agentCfg\?\.elevatedDefault.*?\?\?\s*"(\w+)"\)/);
    expect(fallbackMatch).not.toBeNull();
    expect(fallbackMatch![1]).toBe("off");
  });

  it("elevated is allowed when tools.elevated.enabled + allowFrom match", () => {
    const result = resolveElevatedPermissions({
      cfg: {
        tools: {
          elevated: {
            enabled: true,
            allowFrom: { telegram: ["user123"] },
          },
        },
      },
      agentId: "main",
      ctx: {
        From: "telegram:user123",
        AccountId: "primary",
        SessionKey: "main",
      } as MsgContext,
      provider: "telegram",
    });

    expect(result.enabled).toBe(true);
    expect(result.allowed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("elevated is not allowed when tools.elevated.enabled is false", () => {
    const result = resolveElevatedPermissions({
      cfg: {
        tools: {
          elevated: {
            enabled: false,
            allowFrom: { telegram: ["user123"] },
          },
        },
      },
      agentId: "main",
      ctx: {
        From: "telegram:user123",
        AccountId: "primary",
        SessionKey: "main",
      } as MsgContext,
      provider: "telegram",
    });

    expect(result.enabled).toBe(false);
    expect(result.allowed).toBe(false);
  });
});
