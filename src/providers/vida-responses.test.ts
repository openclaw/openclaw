import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVidaResponsesParamsForTest,
  resolveVidaResponsesOpenAIPathForTest,
} from "./vida-responses.js";

function makeModel(overrides?: Record<string, unknown>) {
  return {
    id: "gpt-5",
    name: "gpt-5",
    provider: "openai",
    api: "openai-responses",
    input: ["text"],
    reasoning: true,
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("vida-responses provider relay metadata", () => {
  it("writes top-level provider_metadata and relay metadata flag", () => {
    const providerMetadata = {
      vida: {
        ignoreOnProviderRelay: true,
        reasoningEffort: "low",
      },
    };
    const params = buildVidaResponsesParamsForTest(
      makeModel(),
      { messages: [{ role: "user", content: "hi" }] },
      {
        providerMetadata,
        reasoningEffort: "high",
      },
    );

    expect(params.provider_metadata).toEqual(providerMetadata);
    expect(params.metadata).toEqual({
      "vida.ignoreOnProviderRelay": "true",
    });
    expect(params.reasoning).toEqual({
      effort: "low",
      summary: "auto",
    });
  });

  it("falls back to message-level providerMetadata when options metadata is absent", () => {
    const params = buildVidaResponsesParamsForTest(
      makeModel(),
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            providerMetadata: {
              vida: {
                ignoreOnProviderRelay: true,
              },
            },
          },
        ],
      },
      {},
    );

    expect(params.provider_metadata).toEqual({
      vida: {
        ignoreOnProviderRelay: true,
      },
    });
    expect(params.metadata).toEqual({
      "vida.ignoreOnProviderRelay": "true",
    });
  });

  it("keeps default reasoning source when relay metadata has no reasoning override", () => {
    const params = buildVidaResponsesParamsForTest(
      makeModel(),
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            providerMetadata: {
              vida: {
                ignoreOnProviderRelay: true,
              },
            },
          },
        ],
      },
      {
        reasoningEffort: "high",
      },
    );

    expect(params.reasoning).toEqual({
      effort: "high",
      summary: "auto",
    });
  });

  it("omits reasoning when relay metadata explicitly requests none", () => {
    const params = buildVidaResponsesParamsForTest(
      makeModel(),
      { messages: [{ role: "user", content: "hi" }] },
      {
        providerMetadata: {
          vida: {
            ignoreOnProviderRelay: true,
            reasoningEffort: "none",
          },
        },
        reasoningEffort: "high",
      },
    );

    expect(params.provider_metadata).toEqual({
      vida: {
        ignoreOnProviderRelay: true,
        reasoningEffort: "none",
      },
    });
    expect(params).not.toHaveProperty("reasoning");
  });
});

describe("vida-responses OpenAI client resolution", () => {
  it("resolves nested openai via the pi-ai package root when pi-ai exports block package.json", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "vida-responses-openai-"));
    tempDirs.push(root);

    const piAiRoot = path.join(root, "node_modules", "@mariozechner", "pi-ai");
    const piAiDist = path.join(piAiRoot, "dist");
    const nestedOpenAiRoot = path.join(piAiRoot, "node_modules", "openai");

    await mkdir(piAiDist, { recursive: true });
    await mkdir(nestedOpenAiRoot, { recursive: true });
    await writeFile(
      path.join(piAiRoot, "package.json"),
      JSON.stringify({
        name: "@mariozechner/pi-ai",
        type: "module",
        exports: {
          ".": {
            import: "./dist/index.js",
          },
        },
      }),
      "utf8",
    );
    await writeFile(path.join(piAiDist, "index.js"), "export {};\n", "utf8");
    await writeFile(
      path.join(nestedOpenAiRoot, "package.json"),
      JSON.stringify({
        name: "openai",
        type: "module",
        exports: {
          ".": "./index.js",
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(nestedOpenAiRoot, "index.js"),
      "export default class OpenAI {}\n",
      "utf8",
    );

    const resolved = await resolveVidaResponsesOpenAIPathForTest(
      {
        resolve: ((specifier: string, options?: { paths?: string[] }) => {
          if (specifier === "openai" && !options) {
            throw new Error("module not found");
          }
          if (specifier === "openai" && options?.paths?.[0] === piAiRoot) {
            return path.join(nestedOpenAiRoot, "index.js");
          }
          throw new Error(`unexpected require.resolve: ${specifier}`);
        }) as unknown as (typeof require)["resolve"],
      },
      (specifier) => {
        if (specifier === "@mariozechner/pi-ai") {
          return pathToFileURL(path.join(piAiDist, "index.js")).href;
        }
        throw new Error(`unexpected import.resolve: ${specifier}`);
      },
    );

    expect(resolved).toBe(path.join(nestedOpenAiRoot, "index.js"));
  });
});
