import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { resolveCreateTarget, routeKey, routeKeyFromSearch } from "./catalog-target.ts";

describe("new-session catalog target", () => {
  it("isolates model-specific drafts while retaining ordinary draft storage keys", () => {
    const plain = {
      agentId: "main",
      requestedAgentId: "main",
      catalogId: "",
      catalogLabel: "",
      startTerminal: false,
    };
    const first = { ...plain, requestedModel: "example/first" };
    const second = { ...plain, requestedModel: "example/second" };
    expect(routeKey(plain)).toBe('["main","",""]');
    expect(routeKey(first)).not.toBe(routeKey(plain));
    expect(routeKey(first)).not.toBe(routeKey(second));
    expect(routeKeyFromSearch("?agent=main&model=example%2Ffirst")).toBe(routeKey(first));
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
      resolveCreateTarget({ request } as unknown as GatewayBrowserClient, "claude", "research"),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledWith("sessions.catalog.list", {
      agentId: "research",
      catalogId: "claude",
      limitPerHost: 1,
    });
  });

  it("resolves native terminal hosts without model-chat eligibility", async () => {
    const request = vi.fn(async () => ({
      catalogs: [
        {
          id: "claude",
          label: "Claude Code",
          capabilities: {
            continueSession: true,
            archive: false,
            startTerminal: true,
          },
          hosts: [
            {
              hostId: "node:dev",
              label: "Dev",
              kind: "node",
              connected: false,
              canStartTerminal: true,
              sessions: [],
            },
          ],
        },
      ],
    }));

    await expect(
      resolveCreateTarget({ request } as unknown as GatewayBrowserClient, "claude", "research"),
    ).resolves.toEqual({
      catalogLabel: "Claude Code",
      startTerminal: true,
      terminalHosts: [{ hostId: "node:dev", label: "Dev" }],
    });
  });
});
