import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute } from "./resolve-route.js";

describe("resolveAgentRoute Microsoft Teams compatibility", () => {
  test("routes legacy single-account configs to the default agent without bindings", () => {
    const cfg: OpenClawConfig = {
      channels: {
        msteams: {
          enabled: true,
          appId: "app-id",
          appPassword: "secret",
          tenantId: "tenant-id",
          webhook: { path: "/api/messages" },
        },
      },
    };

    const route = resolveAgentRoute({
      cfg,
      channel: "msteams",
      accountId: "default",
      peer: { kind: "direct", id: "user-aad-object-id" },
    });

    expect(route).toMatchObject({
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:main",
      lastRoutePolicy: "main",
      matchedBy: "default",
    });
  });
});
