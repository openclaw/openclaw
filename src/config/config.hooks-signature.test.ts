// Covers hooks.mappings[].signature config validation.
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "./validation.js";

const SECRET = `whsec_${Buffer.alloc(32, 1).toString("base64")}`;

function hooksConfig(signature: Record<string, unknown>): Record<string, unknown> {
  return {
    agents: { entries: { openclaw: {} } },
    hooks: {
      enabled: true,
      token: "hook-secret",
      mappings: [{ match: { path: "ambush" }, action: "agent", messageTemplate: "x", signature }],
    },
  };
}

describe("config hooks signature", () => {
  it("accepts a standard-webhooks signature with one secret", () => {
    const res = validateConfigObjectWithPlugins(
      hooksConfig({ scheme: "standard-webhooks", secret: SECRET }),
    );
    expect(res.ok).toBe(true);
  });

  it("accepts several secrets for rotation overlaps and a custom tolerance", () => {
    const res = validateConfigObjectWithPlugins(
      hooksConfig({ scheme: "standard-webhooks", secret: [SECRET, SECRET], toleranceSeconds: 120 }),
    );
    expect(res.ok).toBe(true);
  });

  it("rejects unknown signature schemes", () => {
    const res = validateConfigObjectWithPlugins(
      hooksConfig({ scheme: "hmac-sha1", secret: SECRET }),
    );
    expect(res.ok).toBe(false);
    if (res.ok) {
      throw new Error("expected validation failure");
    }
    expect(res.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.signature.scheme");
  });

  it("requires an explicit custom match.path on signed mappings", () => {
    for (const match of [undefined, { path: "agent" }, { path: "/wake/" }]) {
      const res = validateConfigObjectWithPlugins({
        agents: { entries: { openclaw: {} } },
        hooks: {
          enabled: true,
          token: "hook-secret",
          mappings: [
            {
              ...(match ? { match } : {}),
              action: "agent",
              messageTemplate: "x",
              signature: { scheme: "standard-webhooks", secret: SECRET },
            },
          ],
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.signature");
      }
    }
  });

  it("rejects another mapping that can match a signed path", () => {
    for (const other of [{ match: { path: "ambush", source: "x" } }, {}]) {
      const res = validateConfigObjectWithPlugins({
        agents: { entries: { openclaw: {} } },
        hooks: {
          enabled: true,
          token: "hook-secret",
          mappings: [
            {
              match: { path: "ambush" },
              action: "agent",
              messageTemplate: "x",
              signature: { scheme: "standard-webhooks", secret: SECRET },
            },
            { ...other, action: "agent", messageTemplate: "y" },
          ],
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.signature");
      }
    }
  });

  it("rejects a signed mapping whose id another mapping reuses", () => {
    const res = validateConfigObjectWithPlugins({
      agents: { entries: { openclaw: {} } },
      hooks: {
        enabled: true,
        token: "hook-secret",
        mappings: [
          {
            id: "shared",
            match: { path: "ambush" },
            action: "agent",
            messageTemplate: "x",
            signature: { scheme: "standard-webhooks", secret: SECRET },
          },
          { id: "shared", match: { path: "other" }, action: "agent", messageTemplate: "y" },
        ],
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.map((issue) => issue.path)).toContain("hooks.mappings.0.signature");
    }
  });

  it("rejects an empty secret list", () => {
    const res = validateConfigObjectWithPlugins(
      hooksConfig({ scheme: "standard-webhooks", secret: [] }),
    );
    expect(res.ok).toBe(false);
  });
});
