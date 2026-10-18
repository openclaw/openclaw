import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import {
  loadSessionCostSummary,
  loadSessionLogs,
  loadSessionUsageTimeSeries,
} from "./session-cost-usage.js";
import type { CostBreakdown } from "./session-cost-usage.types.js";

const tempDirs = useStateDatabaseTempDirs();
const breakdown = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const zeroPricing = breakdown();
const flatPricing = breakdown(1, 2, 0.5);
const tieredPricing: ModelDefinitionConfig["cost"] = {
  ...flatPricing,
  tieredPricing: [
    { ...flatPricing, range: [0, 1_000] },
    { ...breakdown(2, 4, 1), range: [1_000, 100_000] },
  ],
};

type PricingCase = [
  name: string,
  expectedCost: number | undefined,
  pricing?: ModelDefinitionConfig["cost"],
  recordedCost?: CostBreakdown,
  expectedBreakdown?: ReturnType<typeof breakdown>,
  mode?: "top-level" | "unavailable",
];
const priorityParts = breakdown(0.004, 0.004, 0.0004);
const billedZero: CostBreakdown = { total: 0, totalOrigin: "provider-billed" };
const interimBill = { ...billedZero, total: 0.001 };
const priorityBill = { total: 0.0084, ...priorityParts };

const text = (value: string) => ({ type: "text", text: value });
const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  role,
  content,
  ...extra,
});
const tool = (type: string, name: string, id = name) => ({ type, name, id });
async function writeTranscript(sessionFile: string, entries: unknown[]) {
  await fs.writeFile(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n"));
}

it.each<PricingCase>([
  ["top-level usage", 0.0021, flatPricing, undefined, breakdown(0.001, 0.001, 0.0001), "top-level"],
  ["unknown zero", undefined, undefined, { total: 0 }],
  ["zero pricing", 0, zeroPricing, { total: 0 }],
  ["interrupted placeholder", undefined, zeroPricing, { total: 0 }, undefined, "unavailable"],
  ["interrupted billing", undefined, undefined, interimBill, undefined, "unavailable"],
  // A later catalog cannot recover the recorded call's service tier.
  ["flat estimate survives tiers", 0.001, tieredPricing, { total: 0.001 }],
  ["priority estimate survives tiers", 0.0084, tieredPricing, priorityBill, priorityParts],
  ["tiered estimate", 0.0042, tieredPricing, undefined, breakdown(0.002, 0.002, 0.0002)],
  ["billed zero survives tiers", 0, tieredPricing, billedZero],
  ["zero with component evidence", 0, undefined, { total: 0, input: 0.25 }, breakdown(0.25)],
])(
  "keeps logs, summaries, and charts consistent for %s",
  async (_name, expectedCost, pricing, recordedCost, expectedBreakdown, mode) => {
    const usageUnavailable = mode === "unavailable";
    const topLevelUsage = mode === "top-level";
    const root = tempDirs.make("openclaw-usage-reporting-");
    const sessionFile = path.join(root, "transcript.jsonl");
    const timestamp = Date.UTC(2026, 7, 1, 12);
    const usage = {
      ...breakdown(1_000, 500, 200),
      totalTokens: 1_700,
      ...(usageUnavailable ? { usageReport: { state: "unavailable" } } : {}),
      ...(recordedCost ? { cost: recordedCost } : {}),
    };
    const entries = [
      { message: message("user", "Question", { timestamp: timestamp - 1 }) },
      {
        provider: "reporting",
        model: "fixture-model",
        ...(topLevelUsage ? { usage } : {}),
        message: message("assistant", [text("Answer"), { type: "tool_use", name: "lookup" }], {
          timestamp,
          ...(topLevelUsage ? {} : { usage }),
        }),
      },
      {
        message: message("toolResult", "Done", {
          toolName: "lookup",
          timestamp: timestamp + 1,
        }),
      },
    ];
    await writeTranscript(sessionFile, entries);
    const config: OpenClawConfig = {};
    if (pricing) {
      const id = "fixture-model";
      config.models = {
        providers: {
          reporting: {
            baseUrl: "https://reporting.invalid",
            models: [
              { id, name: id, cost: pricing, reasoning: false, input: ["text"], maxTokens: 8000 },
            ],
          },
        },
      };
    }

    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      const params = { agentId: "main", sessionFile, config };
      const logs = await loadSessionLogs(params);
      expect(logs).toEqual([
        expect.objectContaining({ role: "user", content: "Question" }),
        {
          ...message("assistant", "Answer\n[Tool: lookup]", { timestamp }),
          tokens: usageUnavailable ? undefined : 1_700,
          cost: expectedCost,
        },
        expect.objectContaining({
          role: "toolResult",
          content: "[Tool: lookup]\n[Tool Result]\nDone",
        }),
      ]);

      const summary = await loadSessionCostSummary(params);
      const expectedReport = usageUnavailable ? { state: "unavailable" } : undefined;
      expect(summary).toMatchObject({
        totalTokens: usageUnavailable ? 0 : 1_700,
        missingCostEntries: expectedCost === undefined ? 1 : 0,
      });
      expect([
        summary?.usageReport,
        summary?.dailyBreakdown?.[0]?.usageReport,
        summary?.modelUsage?.[0]?.totals.usageReport,
        summary?.dailyModelUsage?.[0]?.usageReport,
        summary?.utcQuarterHourTokenUsage?.find((bucket) => bucket.quarterIndex === 48)
          ?.usageReport,
      ]).toEqual(Array(5).fill(expectedReport));
      expect(summary?.totalCost).toBeCloseTo(expectedCost ?? 0, 8);
      for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        expect(summary?.[`${field}Cost`]).toBeCloseTo(expectedBreakdown?.[field] ?? 0, 8);
      }

      const series = await loadSessionUsageTimeSeries(params);
      expect(series?.usageReport).toEqual(expectedReport);
      if (usageUnavailable) {
        expect(series?.points).toEqual([]);
      } else {
        expect(series?.points).toHaveLength(1);
        expect(series?.points[0]?.totalTokens).toBe(1_700);
        expect(series?.points[0]?.cost).toBeCloseTo(expectedCost ?? 0, 8);
      }
    });
  },
);

it("preserves canonical tool calls and mixed content order in session logs", async () => {
  const root = tempDirs.make("openclaw-usage-tool-blocks-");
  const sessionFile = path.join(root, "transcript.jsonl");
  const timestamp = Date.UTC(2026, 7, 1, 12);
  const messages = [
    message("user", "Question"),
    message("assistant", [tool("toolCall", "read", "call-only")]),
    message("assistant", [tool(" toolUse ", " legacy-only ")]),
    message("assistant", [
      text("Before"),
      tool(" TOOL_CALL ", "read"),
      text("Between"),
      tool("toolCall", "read"),
      tool("tool_use", " legacy "),
      tool("tooluse", "lowercase"),
      text("After"),
    ]),
    message("assistant", [text("Ordinary answer")]),
    message("toolResult", [text("Done")], { toolCallId: "call-only", toolName: "read" }),
  ];
  await writeTranscript(
    sessionFile,
    messages.map((entry, index) => ({
      type: "message",
      timestamp: new Date(timestamp + index).toISOString(),
      message: entry,
    })),
  );

  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    const logs = await loadSessionLogs({ agentId: "main", sessionFile, config: {} });
    expect(logs?.map(({ role, content }) => [role, content])).toEqual([
      ["user", "Question"],
      ["assistant", "[Tool: read]"],
      ["assistant", "[Tool:  legacy-only ]"],
      [
        "assistant",
        "Before\n[Tool: read]\nBetween\n[Tool: read]\n[Tool:  legacy ]\n[Tool: lowercase]\nAfter",
      ],
      ["assistant", "Ordinary answer"],
      ["toolResult", "[Tool: read]\n[Tool Result]\nDone"],
    ]);
  });
});
