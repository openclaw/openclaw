import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation.ts";

const schemaSource = fs.readFileSync(
  new URL("./zod-schema.agent-runtime.ts", import.meta.url),
  "utf8",
);

describe("web search Codex native config validation", () => {
  it("keeps tools.web.search.openaiCodex in the runtime schema", () => {
    expect(schemaSource).toContain("openaiCodex");
    expect(schemaSource).toContain('z.literal("cached")');
    expect(schemaSource).toContain('z.literal("live")');
    expect(schemaSource).toContain('z.literal("low")');
    expect(schemaSource).toContain('z.literal("medium")');
    expect(schemaSource).toContain('z.literal("high")');
    expect(schemaSource).toContain("allowedDomains");
    expect(schemaSource).toContain("userLocation");
  });

  it("rejects invalid openaiCodex.mode", () => {
    const result = validateConfigObjectRaw({
      tools: {
        web: {
          search: {
            openaiCodex: {
              enabled: true,
              mode: "realtime",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "tools.web.search.openaiCodex.mode",
      );
      expect(issue?.allowedValues).toEqual(["cached", "live"]);
    }
  });

  it("rejects invalid openaiCodex.contextSize", () => {
    const result = validateConfigObjectRaw({
      tools: {
        web: {
          search: {
            openaiCodex: {
              enabled: true,
              contextSize: "huge",
            },
          },
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.issues.find(
        (entry) => entry.path === "tools.web.search.openaiCodex.contextSize",
      );
      expect(issue?.allowedValues).toEqual(["low", "medium", "high"]);
    }
  });
});
