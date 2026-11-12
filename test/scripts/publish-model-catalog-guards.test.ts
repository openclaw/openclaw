// Publisher task facts and guards: v3-only inference rows, plus the catalog v3 pre-flip
// audit's strict inference fields, explicit non-chat rows, v1 size, and shrinkage.
import fs from "node:fs";
import path from "node:path";
import * as catalog from "@openclaw/model-catalog-core";
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
  extra?: Record<string, Record<string, unknown> & { models: Row[] }>;
  chatRows?: number;
  authChoices?: Array<{ provider: string; onboardingScopes?: string[] }>;
  /** Standalone LiteLLM prices; v1 lists each under two keys, so they grow v1 fastest. */
  standalonePrices?: number;
  /** Publish v1 and v3 only, as a feed set without v2. */
  withoutV2?: boolean;
}) {
  const rootDir = tempDirs.make("openclaw-catalog-guards-");
  const providers = {
    anthropic: { models: [{ id: "chat-a" }] },
    openai: {
      models: Array.from({ length: (options.chatRows ?? 200) - 1 }, (_, index) => ({
        id: `chat-${index}`,
      })),
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
          ...(options.withoutV2 ? [] : ["--out-v2", files.v2]),
          "--out-v3",
          files.v3,
          ...extraArgs,
        ],
      }),
  };
}

const unwritten = (files: Record<string, string>) =>
  expect(Object.values(files).filter((file) => fs.existsSync(file))).toEqual([]);

it("refuses unknown inference fields (audit fixtures 16-18, 29) instead of stripping them", async () => {
  const inference = {
    chat: false,
    image: { generate: true },
    decision: {
      ...decision,
      futureField: 1,
      billing: { ...decision.billing, futureField: 1 },
      questions: { ...decision.questions, rank: { probabilities: "none", abstention: false } },
    },
  };
  const { files, run } = fixture({ extra: { levanto: { models: [{ id: "sage", inference }] } } });
  const error = await run().catch((cause: unknown) => String(cause));
  for (const field of [
    "image",
    "decision.futureField",
    "decision.billing.futureField",
    "decision.questions.rank",
  ]) {
    expect(error).toContain(`inference.${field}`);
  }
  unwritten(files);
});

it("requires chat: false on rows of a provider offered only for media (audit fixture 61)", async () => {
  const row = { id: "audit-media-no-inference" };
  const authChoices = [
    { provider: "media", onboardingScopes: ["image-generation", "music-generation"] },
    { provider: "mixed", onboardingScopes: ["text-inference", "image-generation"] },
    { provider: "openai" },
  ];
  const chat = { mixed: { models: [{ id: "chat-model" }] } };
  const refused = fixture({ extra: { ...chat, media: { models: [row] } }, authChoices });
  await expect(refused.run()).rejects.toThrow(
    "fixture: provider media is offered only for image-generation, music-generation; model media/audit-media-no-inference must declare inference.chat: false",
  );
  unwritten(refused.files);
  const marked = { ...row, inference: { chat: false } };
  const { files, run } = fixture({ extra: { ...chat, media: { models: [marked] } }, authChoices });
  await run();
  const v3 = JSON.parse(fs.readFileSync(files.v3, "utf8"));
  expect(v3.models.find((model: Row) => model.id === row.id)?.inference).toEqual({ chat: false });
  expect(JSON.parse(fs.readFileSync(files.v2, "utf8")).providers).not.toHaveProperty("media");
});

describe("feed size", () => {
  // Live v1 is 92% of the cap mostly from standalone prices; v2 and v3 are 45%.
  it("warns above 90% of the client cap", async () => {
    const { run, stderr } = fixture({ standalonePrices: 25_500 });
    await run();
    expect(stderr.join("")).toMatch(/warning: v1 bundle \d+ bytes is 9\d\.\d% of the 4194304-byte/);
    expect(stderr.join("")).not.toMatch(/warning: v[23] bundle/);
  });

  it("publishes v2 and v3 over an oversized v1 only with --skip-oversized-v1", async () => {
    const { files, run } = fixture({ standalonePrices: 31_000 });
    await expect(run()).rejects.toThrow("exceeds client limit 4194304 bytes");
    unwritten(files);
    fs.writeFileSync(files.v1, "previous v1\n");
    await expect(run("--skip-oversized-v1")).resolves.toMatchObject({ v1Skipped: true });
    expect(fs.readFileSync(files.v1, "utf8")).toBe("previous v1\n");
    expect(JSON.parse(fs.readFileSync(files.v3, "utf8")).models).toHaveLength(200);
  });

  it("keeps the previous v3 when the lone v3 left by --skip-oversized-v1 fails mid-write", async () => {
    const { files, run } = fixture({ standalonePrices: 31_000, withoutV2: true });
    fs.writeFileSync(files.v3, "previous v3\n");
    const realWrite = fs.writeFileSync;
    // A full disk: the v3 write lands half its bytes, then fails.
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, options) => {
      if (typeof data === "string" && data.includes('"schemaVersion": 3')) {
        realWrite(target, data.slice(0, data.length / 2), options);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realWrite(target, data, options);
    });
    await expect(run("--skip-oversized-v1")).rejects.toThrow("ENOSPC");
    expect(fs.readFileSync(files.v3, "utf8")).toBe("previous v3\n");
  });
});

it("refuses a v3 shrink above 5% or a lost provider unless --allow-shrink", async () => {
  const { files, rootDir, run } = fixture({});
  const previous = path.join(rootDir, "published-v3.json");
  const publish = (rows: number, providers: string[], ...args: string[]) => {
    writeJsonFile(previous, {
      schemaVersion: 3,
      providers: Object.fromEntries(providers.map((id) => [id, {}])),
      models: Array.from({ length: rows }, (_, index) => ({ id: `m-${index}` })),
    });
    return run("--previous-v3", previous, "--previous", path.join(rootDir, "absent.json"), ...args);
  };
  await expect(publish(212, ["anthropic", "openai"])).rejects.toThrow("212 -> 200 rows (-5.7%)");
  await expect(publish(200, ["anthropic", "openai", "gone"])).rejects.toThrow(
    "lost providers gone",
  );
  unwritten(files);
  await expect(publish(212, ["openai", "gone"], "--allow-shrink")).resolves.toMatchObject({
    wrote: true,
  });
  await expect(publish(210, ["anthropic", "openai"])).resolves.toMatchObject({ wrote: true });
});

describe("task facts", () => {
  const native = {
    id: "native",
    baseUrl: "https://fixture.invalid/private",
    inference: {
      chat: false,
      decision: { ...decision, billing: { ...decision.billing, usdPerMillion: { input: 0 } } },
    },
  };
  const extra = (chatRows: number) => ({
    openai: {
      authScope: "agent",
      models: Array.from({ length: chatRows - 1 }, (_, index) => ({
        id: `chat-${index}`,
        ...(index === 0 ? { inference: { chat: true, decision } } : {}),
      })),
    },
    fixture: {
      authScope: "plugin",
      defaultModel: "native",
      headers: { "X-F": "x" },
      models: [native],
    },
  });

  it("publishes task facts only on the opt-in v3 wire", async () => {
    const { files, run } = fixture({ extra: extra(200) });
    await run();
    const [v1, v2, v3] = [files.v1, files.v2, files.v3].map((file) =>
      JSON.parse(fs.readFileSync(file, "utf8")),
    );
    expect(catalog.parseRemoteModelCatalogBundle(v1).providers).not.toHaveProperty("fixture");
    expect(catalog.parseRemoteModelCatalogBundleV2(v2).models).toHaveLength(200);
    const parsedV3 = catalog.parseRemoteModelCatalogBundleV3(v3);
    expect(parsedV3.models).toHaveLength(201);
    expect(parsedV3.providers.fixture).toEqual({});
    const row = parsedV3.models.find((model) => model.id === "native");
    expect(row).toMatchObject({ inference: native.inference, pricing: { status: "unknown" } });
    expect(row).not.toHaveProperty("baseUrl");
    expect(parsedV3.models.find((model) => model.id === "chat-0")?.inference?.chat).toBe(true);
    expect(v2.models.find((model: Row) => model.id === "chat-0")).not.toHaveProperty("inference");
  });

  it("does not use native-only rows to satisfy the released chat catalog floor", async () => {
    const { files, run } = fixture({ extra: extra(199) });
    await expect(run()).rejects.toThrow("below required floor");
    unwritten(files);
  });
});
