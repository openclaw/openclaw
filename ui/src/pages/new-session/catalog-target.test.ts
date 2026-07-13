import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { allowsSelectedAgent, resolveCreateTarget, routeKey } from "./catalog-target.ts";

describe("new-session catalog target", () => {
  it("keeps the draft identity stable while target metadata resolves", () => {
    const pending = { agentId: "main", catalogId: "claude", model: "", catalogLabel: "" };
    const ready = {
      ...pending,
      model: "anthropic/claude-opus-4-8",
      catalogLabel: "Claude Code",
    };

    expect(routeKey(pending)).toBe(routeKey(ready));
    expect(allowsSelectedAgent(pending, { id: "main" })).toBe(false);
    expect(allowsSelectedAgent(ready, { id: "main" })).toBe(true);
  });

  it("fails closed when the requested creation capability is unavailable", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: { continueSession: true, archive: false },
          hosts: [],
        },
      ],
    }));

    await expect(
      resolveCreateTarget({ request } as unknown as GatewayBrowserClient, "claude"),
    ).resolves.toBeUndefined();
  });
});
