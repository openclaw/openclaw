// Publisher guards found by the catalog v3 pre-flip audit: strict inference fields,
// explicit non-chat rows, an oversized v1 that must not block v2/v3, and shrinkage.
import fs from "node:fs";
import path from "node:path";
import { LITELLM_PRICING_URL } from "@openclaw/model-catalog-core/model-catalog-pricing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

// The live levanto-sage declaration shape, as mutated by audit fixtures 16-18 and 29.
const decision = {
  protocol: "fixture-decide",
  input: ["text"],
  questions: { boolean: { probabilities: "boolean", abstention: true } },
  billing: { unit: "tokens", source: "provider-docs" },
};

type Row = Record<string, unknown> & { id: string };

function fixture(options: {
  extra?: Record<string, { models: Row[] }>;
  authChoices?: Array<{ provider: string; onboardingScopes?: string[] }>;
  /** Standalone LiteLLM prices; v1 lists each under two keys, so they grow v1 fastest. */
  standalonePrices?: number;
}) {
  const rootDir = tempDirs.make("openclaw-catalog-guards-");
  const providers = {
    anthropic: { models: [{ id: "chat-a" }] },
    openai: {
      models: Array.from({ length: 199 }, (_, index) => ({ id: `chat-${index}` })),
    },
    ...options.extra,
  };
  writeJsonFile(path.join(rootDir, "extensions/fixture/openclaw.plugin.json"), {
    providers: Object.keys(providers),
    ...(options.authChoices ? { providerAuthChoices: options.authChoices } : {}),
    modelCatalog: { providers },
  });
  writeJsonFile(path.join(rootDir, "scripts/lib/recommended-models.json"), []);
  const files = {
    v1: path.join(rootDir, "v1.json"),
    v2: path.join(rootDir, "v2.json"),
    v3: path.join(rootDir, "v3.json"),
  };
  const stderr: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    rootDir,
    files,
    stderr,
    run: (...extraArgs: string[]) =>
      runPublishModelCatalog({
        rootDir,
        sourceCommit: "fixture",
        now: () => 42,
        fetchImpl: async (input) => {
          if (options.standalonePrices === undefined) {
            throw new Error("fixture must not discover external models");
          }
          if (String(input instanceof Request ? input.url : input) !== LITELLM_PRICING_URL) {
            return Response.json({});
          }
          return Response.json(
            Object.fromEntries(
              Array.from({ length: options.standalonePrices }, (_, index) => [
                `standalone-model-${index}`,
                {
                  litellm_provider: "custom",
                  input_cost_per_token: 0.000001,
                  output_cost_per_token: 0.000002,
                },
              ]),
            ),
          );
        },
        args: [
          ...(options.standalonePrices === undefined ? [] : ["--pricing"]),
          "--out",
          files.v1,
          "--out-v2",
          files.v2,
          "--out-v3",
          files.v3,
          ...extraArgs,
        ],
      }),
  };
}

const written = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([feed, file]) => [feed, fs.existsSync(file)]));

describe("inference declarations are strict on the publisher path", () => {
  it.each([
    [
      "16 new kind in inference",
      { chat: false, decision, image: { generate: true } },
      "inference.image",
    ],
    [
      "17 new field in decision",
      { chat: false, decision: { ...decision, futureField: 1 } },
      "inference.decision.futureField",
    ],
    [
      "18 new field in decision.billing",
      { chat: false, decision: { ...decision, billing: { ...decision.billing, futureField: 1 } } },
      "inference.decision.billing.futureField",
    ],
    [
      "29 new decision question kind",
      {
        chat: false,
        decision: {
          ...decision,
          questions: { ...decision.questions, rank: { probabilities: "none", abstention: false } },
        },
      },
      "inference.decision.questions.rank",
    ],
  ])(
    "refuses audit fixture %s instead of publishing it stripped",
    async (_name, inference, field) => {
      const { files, run } = fixture({
        extra: { levanto: { models: [{ id: "sage", inference }] } },
      });
      await expect(run()).rejects.toThrow(`model levanto/sage: unknown field ${field}`);
      expect(written(files)).toEqual({ v1: false, v2: false, v3: false });
    },
  );
});

describe("non-chat rows declare chat: false", () => {
  // Audit fixture 61: the row every reader would list as a chat model.
  const mediaRow = { id: "audit-media-no-inference", name: "AUDIT media row without inference" };
  const mediaOnly = [
    { provider: "media", onboardingScopes: ["image-generation", "music-generation"] },
  ];

  it("refuses a row without inference on a provider offered only for media generation", async () => {
    const { files, run } = fixture({
      extra: { media: { models: [mediaRow] } },
      authChoices: mediaOnly,
    });
    await expect(run()).rejects.toThrow(
      "fixture: provider media is offered only for image-generation, music-generation; model media/audit-media-no-inference must declare inference.chat: false",
    );
    expect(written(files)).toEqual({ v1: false, v2: false, v3: false });
  });

  it("publishes the same row once it declares chat: false, on v3 only", async () => {
    const { files, run } = fixture({
      extra: { media: { models: [{ ...mediaRow, inference: { chat: false } }] } },
      authChoices: mediaOnly,
    });
    await run();
    const [v1, v2, v3] = [files.v1, files.v2, files.v3].map((file) =>
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    expect(v1.providers).not.toHaveProperty("media");
    expect(v2.providers).not.toHaveProperty("media");
    expect(v3.models.find((model: Row) => model.id === mediaRow.id)?.inference).toEqual({
      chat: false,
    });
  });

  it("keeps text-inference providers and auth choices without scopes as chat surfaces", async () => {
    const { run } = fixture({
      extra: { mixed: { models: [{ id: "chat-model" }] } },
      authChoices: [
        { provider: "mixed", onboardingScopes: ["text-inference", "image-generation"] },
        { provider: "openai" },
      ],
    });
    await expect(run()).resolves.toMatchObject({ wrote: true });
  });

  it("refuses a Decision declaration that leaves chat implicit", async () => {
    const { run } = fixture({
      extra: { levanto: { models: [{ id: "sage", inference: { decision } }] } },
    });
    await expect(run()).rejects.toThrow(/inference.*chat|chat.*expected boolean/is);
  });
});

describe("feed size", () => {
  // Live v1 is 92% of the cap mostly from standalone prices; v2 and v3 are 45%.

  it("warns above 90% of the client cap", async () => {
    const { run, stderr } = fixture({ standalonePrices: 25_500 });
    await run();
    expect(stderr.join("")).toMatch(
      /warning: v1 bundle \d+ bytes is 9\d\.\d% of the 4194304-byte client limit/,
    );
    expect(stderr.join("")).not.toMatch(/warning: v[23] bundle/);
  });

  it("fails every feed on an oversized v1 unless asked to skip only v1", async () => {
    const { files, run } = fixture({ standalonePrices: 31_000 });
    await expect(run()).rejects.toThrow("exceeds client limit 4194304 bytes");
    expect(written(files)).toEqual({ v1: false, v2: false, v3: false });
  });

  it("publishes v2 and v3 and leaves the previous v1 in place with --skip-oversized-v1", async () => {
    const { files, run, stderr } = fixture({ standalonePrices: 31_000 });
    fs.writeFileSync(files.v1, "previous v1\n");
    await expect(run("--skip-oversized-v1")).resolves.toMatchObject({ v1Skipped: true });
    expect(fs.readFileSync(files.v1, "utf8")).toBe("previous v1\n");
    expect(JSON.parse(fs.readFileSync(files.v2, "utf8")).models).toHaveLength(200);
    expect(JSON.parse(fs.readFileSync(files.v3, "utf8")).models).toHaveLength(200);
    expect(stderr.join("")).toContain("v1 not written, the previous v1 stays served");
  });
});

describe("shrink guard", () => {
  const previousV3 = (rows: number, providers: string[]) => ({
    schemaVersion: 3,
    providers: Object.fromEntries(providers.map((id) => [id, {}])),
    models: Array.from({ length: rows }, (_, index) => ({
      id: `m-${index}`,
      provider: providers[0],
    })),
  });

  it.each([
    ["more than 5% of rows", previousV3(212, ["anthropic", "openai"]), "212 -> 200 rows (-5.7%)"],
    ["a provider", previousV3(200, ["anthropic", "openai", "gone"]), "lost providers gone"],
  ])("refuses a v3 that lost %s unless --allow-shrink", async (_name, previous, message) => {
    const { files, rootDir, run } = fixture({});
    const previousFile = path.join(rootDir, "published-v3.json");
    writeJsonFile(previousFile, previous);
    await expect(run("--previous-v3", previousFile)).rejects.toThrow(message);
    expect(written(files)).toEqual({ v1: false, v2: false, v3: false });
    await expect(run("--previous-v3", previousFile, "--allow-shrink")).resolves.toMatchObject({
      wrote: true,
    });
  });

  it("accepts a drop within 5% and a missing previous file", async () => {
    const { rootDir, run } = fixture({});
    const previousFile = path.join(rootDir, "published-v3.json");
    writeJsonFile(previousFile, previousV3(210, ["anthropic", "openai"]));
    await expect(
      run("--previous-v3", previousFile, "--previous", path.join(rootDir, "absent.json")),
    ).resolves.toMatchObject({ wrote: true });
  });
});
