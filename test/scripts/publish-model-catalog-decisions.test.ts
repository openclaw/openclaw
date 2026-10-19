import fs from "node:fs";
import path from "node:path";
import {
  parseRemoteModelCatalogBundle,
  parseRemoteModelCatalogBundleV2,
  parseRemoteModelCatalogBundleV3,
} from "@openclaw/model-catalog-core";
import { afterEach, expect, it, vi } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture(chatModels = 200) {
  const rootDir = tempDirs.make("openclaw-catalog-decisions-");
  const manifestDir = path.join(rootDir, "extensions", "fixture");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, "openclaw.plugin.json"),
    JSON.stringify({
      providers: ["anthropic", "openai", "fixture"],
      modelCatalog: {
        providers: {
          anthropic: { models: [{ id: "chat-a" }] },
          openai: {
            authScope: "agent",
            models: Array.from({ length: chatModels - 1 }, (_, index) => ({
              id: `chat-${index}`,
              ...(index === 0
                ? {
                    inference: {
                      chat: true,
                      decision: { protocol: "fixture.decisions", input: ["text"] },
                    },
                  }
                : {}),
            })),
          },
          fixture: {
            authScope: "plugin",
            defaultModel: "native",
            defaultUtilityModel: "native",
            headers: { "X-Fixture": "not-a-secret" },
            models: [
              {
                id: "native",
                input: ["text"],
                baseUrl: "https://fixture.invalid/private",
                inference: {
                  chat: false,
                  decision: {
                    protocol: "fixture.decisions",
                    input: ["text"],
                    questions: { boolean: { probabilities: "boolean", abstention: false } },
                    billing: {
                      unit: "tokens",
                      source: "provider-docs",
                      usdPerMillion: { input: 0, output: 0 },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    }),
  );
  fs.mkdirSync(path.join(rootDir, "scripts", "lib"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "scripts", "lib", "recommended-models.json"), "[]");
  const files = [
    path.join(rootDir, "v1.json"),
    path.join(rootDir, "v2.json"),
    path.join(rootDir, "v3.json"),
  ] as const;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    files,
    run: () =>
      runPublishModelCatalog({
        rootDir,
        sourceCommit: "fixture",
        now: () => 42,
        fetchImpl: async () => {
          throw new Error("fixture must not discover external models");
        },
        args: ["--out", files[0], "--out-v2", files[1], "--out-v3", files[2]],
      }),
  };
}

it("publishes native capabilities only to the negotiated v3 output", async () => {
  const { files, run } = fixture();
  await expect(run()).resolves.toMatchObject({ wrote: true });
  const payloads = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const v1 = parseRemoteModelCatalogBundle(payloads[0]);
  const v2 = parseRemoteModelCatalogBundleV2(payloads[1]);
  const v3 = parseRemoteModelCatalogBundleV3(payloads[2]);
  expect(v1.providers).not.toHaveProperty("fixture");
  expect(v2.providers).not.toHaveProperty("fixture");
  expect(v2.models).toHaveLength(200);
  expect(v3.models).toHaveLength(201);
  expect(v3.models.find((model) => model.id === "chat-0")?.inference).toEqual({
    chat: true,
    decision: { protocol: "fixture.decisions", input: ["text"] },
  });
  const native = v3.models.find((model) => model.provider === "fixture");
  expect(native).toMatchObject({
    id: "native",
    inference: {
      chat: false,
      decision: {
        protocol: "fixture.decisions",
        billing: { usdPerMillion: { input: 0, output: 0 } },
      },
    },
  });
  expect(native).not.toHaveProperty("baseUrl");
  expect(v3.providers.fixture).toEqual({});
});

it("does not use native-only rows to satisfy the released chat catalog floor", async () => {
  const { files, run } = fixture(199);
  await expect(run()).rejects.toThrow("below required floor");
  expect(files.some((file) => fs.existsSync(file))).toBe(false);
});
