// Doctor tells users whose config still pins a former onboarding output cap that the
// default changed; it never rewrites the saved value.
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const CHECK_ID = "core/doctor/legacy-output-cap";

async function detect(providers: Record<string, unknown>) {
  const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === CHECK_ID);
  if (!check) {
    throw new Error("missing registered legacy output cap check");
  }
  expect(typeof check.repair).toBe("undefined");
  const cfg = { models: { providers } } as unknown as OpenClawConfig;
  const before = structuredClone(cfg);
  const findings = await check.detect({ mode: "lint", runtime: createTestRuntime(), cfg });
  expect(cfg).toEqual(before);
  return findings;
}

function row(id: string, extra: Record<string, unknown> = {}) {
  return { id, name: id, ...extra };
}

describe(CHECK_ID, () => {
  it.each([4096, 8192])(
    "reports matching saved caps without promising an increase (%i)",
    async (saved) => {
      const findings = await detect({
        custom: { baseUrl: "http://llm.example/v1", models: [row("big", { maxTokens: saved })] },
      });
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: CHECK_ID,
          severity: "info",
          target: "custom",
          path: "models.providers.custom.models",
        }),
      ]);
      expect(findings[0]?.message).toContain(`big (${saved})`);
      expect(findings[0]?.message).toContain("up to 32768 tokens");
      expect(findings[0]?.message).toContain("may leave the output cap unchanged or lower it");
      expect(findings[0]?.message).not.toContain("capped lower than new setups");
    },
  );

  it("uses the context-sized default when the row has a small window", async () => {
    const findings = await detect({
      local: { models: [row("small", { maxTokens: 4096, contextWindow: 32_768 })] },
    });
    expect(findings[0]?.message).toContain("up to 16384 tokens");
  });

  it("prefers the served window over the training window", async () => {
    const findings = await detect({
      local: {
        models: [row("served", { maxTokens: 4096, contextWindow: 131_072, contextTokens: 16_384 })],
      },
    });
    expect(findings[0]?.message).toContain("up to 8192 tokens");
  });

  it.each([
    ["a non-legacy cap", row("chosen", { maxTokens: 16_384 })],
    ["no saved cap", row("unset")],
    [
      "a window too small to raise the cap",
      row("tiny", { maxTokens: 8192, contextWindow: 16_384 }),
    ],
  ])("stays quiet for %s", async (_label, model) => {
    expect(await detect({ custom: { models: [model] } })).toEqual([]);
  });

  it("stays quiet when a provider-level cap owns the default", async () => {
    expect(
      await detect({ custom: { maxTokens: 4096, models: [row("big", { maxTokens: 4096 })] } }),
    ).toEqual([]);
  });

  it("stays quiet for Mistral, whose 8192 cap is intentional", async () => {
    expect(await detect({ Mistral: { models: [row("x", { maxTokens: 8192 })] } })).toEqual([]);
  });

  it("groups rows per provider and bounds the listed ids", async () => {
    const models = Array.from({ length: 7 }, (_, index) => row(`m${index}`, { maxTokens: 4096 }));
    const findings = await detect({
      a: { models },
      b: { models: [row("other", { maxTokens: 8192 })] },
    });
    expect(findings.map((finding) => finding.target)).toEqual(["a", "b"]);
    expect(findings[0]?.message).toContain("m4 (4096) and 2 more");
    expect(findings[0]?.message).not.toContain("m5");
  });

  it("sanitizes provider and model ids", async () => {
    const findings = await detect({
      "bad\u001b[31m\nprov": { models: [row("evil\u001b[31m\nid", { maxTokens: 4096 })] },
    });
    expect(findings).toHaveLength(1);
    for (const text of [findings[0]?.message, findings[0]?.target, findings[0]?.path]) {
      expect(text).not.toContain("\u001b");
      expect(text).not.toContain("\n");
    }
  });

  it("ignores malformed providers and rows", async () => {
    expect(
      await detect({ broken: "nope", rows: { models: ["x", null, { maxTokens: "4096" }] } }),
    ).toEqual([]);
  });
});
