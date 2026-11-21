import type { IncomingMessage } from "node:http";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureHttpRequestAuthority } from "./http-request-authority.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";

it.each(["absent", "catalog-only", "default"] as const)(
  "fences HTTP authority on role assignment changes only with a default: %s",
  (roles) => {
    const cfg: OpenClawConfig = {
      gateway: {
        auth: { mode: "token", token: "test-secret" },
        ...(roles !== "absent"
          ? {
              roles: {
                ...(roles === "default" ? { default: "guest" } : {}),
                definitions: {
                  guest: { sessions: { others: "none" as const }, agents: [], scopes: [] },
                },
              },
            }
          : {}),
      },
    };
    const isCurrent = captureHttpRequestAuthority({
      req: { headers: {}, socket: { destroyed: false } } as IncomingMessage,
      auth: { mode: "token", token: "test-secret", allowTailscale: false },
      cfg,
      getRuntimeConfig: () => cfg,
    });
    expect(isCurrent()).toBe(true);
    invalidateOperatorRolePolicy("another-profile");
    expect(isCurrent()).toBe(roles !== "default");
  },
);
