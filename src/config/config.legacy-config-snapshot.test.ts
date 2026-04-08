import { describe, expect, it } from "vitest";
import { readConfigFileSnapshot, validateConfigObject } from "./config.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";

describe("config strict validation", () => {
  it("rejects unknown fields", async () => {
    const res = validateConfigObject({
      agents: { list: [{ id: "pi" }] },
      customUnknownField: { nested: "value" },
    });
    expect(res.ok).toBe(false);
  });

  it("accepts documented agents.list[].params overrides", () => {
    const res = validateConfigObject({
      agents: {
        list: [
          {
            id: "main",
            model: "anthropic/claude-opus-4-6",
            params: {
              cacheRetention: "none",
              temperature: 0.4,
              maxTokens: 8192,
            },
          },
        ],
      },
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.agents?.list?.[0]?.params).toEqual({
        cacheRetention: "none",
        temperature: 0.4,
        maxTokens: 8192,
      });
    }
  });

  it("does not treat resolved-only gateway.bind aliases as source-literal legacy or invalid", async () => {
    await withTempHome(async (home) => {
      await writeOpenClawConfig(home, {
        gateway: { bind: "${OPENCLAW_BIND}" },
      });

      const prev = process.env.OPENCLAW_BIND;
      process.env.OPENCLAW_BIND = "0.0.0.0";
      try {
        const snap = await readConfigFileSnapshot();
        expect(snap.valid).toBe(true);
        expect(snap.legacyIssues).toHaveLength(0);
        expect(snap.issues).toHaveLength(0);
      } finally {
        if (prev === undefined) {
          delete process.env.OPENCLAW_BIND;
        } else {
          process.env.OPENCLAW_BIND = prev;
        }
      }
    });
  });
});
