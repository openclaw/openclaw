import fs from "node:fs";
import path from "node:path";
import * as catalog from "@openclaw/model-catalog-core";
import { afterEach, expect, it, vi } from "vitest";
import { runPublishModelCatalog } from "../../scripts/publish-model-catalog.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeJsonFile } from "../helpers/temp-repo.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const decision = { protocol: "fixture.decisions", input: ["text"] };
const nativeModel = {
  id: "native",
  baseUrl: "https://fixture.invalid/private",
  inference: {
    chat: false,
    decision: {
      ...decision,
      billing: { unit: "tokens", source: "provider-docs", usdPerMillion: { input: 0, output: 0 } },
    },
  },
};

function fixture(chatModels = 200) {
  const rootDir = tempDirs.make("openclaw-catalog-decisions-");
  const providers = {
    anthropic: { models: [{ id: "chat-a" }] },
    openai: {
      authScope: "agent",
      models: Array.from({ length: chatModels - 1 }, (_, index) => ({
        id: `chat-${index}`,
        ...(index === 0 ? { inference: { chat: true, decision } } : {}),
      })),
    },
    fixture: {
      authScope: "plugin",
      defaultModel: "native",
      defaultUtilityModel: "native",
      headers: { "X-Fixture": "not-a-secret" },
      models: [nativeModel],
    },
  };
  writeJsonFile(path.join(rootDir, "extensions/fixture/openclaw.plugin.json"), {
    providers: Object.keys(providers),
    modelCatalog: { providers },
  });
  writeJsonFile(path.join(rootDir, "scripts/lib/recommended-models.json"), []);
  const file = (version: number) => path.join(rootDir, `v${version}.json`);
  const files = [file(1), file(2)] as const;
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
        args: ["--out", files[0], "--out-v2", files[1]],
      }),
  };
}

it("omits native-only rows and capabilities from the released outputs", async () => {
  const { files, run } = fixture();
  await expect(run()).resolves.toMatchObject({ wrote: true });
  const payloads = files.map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const v1 = catalog.parseRemoteModelCatalogBundle(payloads[0]);
  const v2 = catalog.parseRemoteModelCatalogBundleV2(payloads[1]);
  expect(v1.providers).not.toHaveProperty("fixture");
  expect(v2.providers).not.toHaveProperty("fixture");
  expect(v2.models).toHaveLength(200);
  expect(v2.models.find((model) => model.id === "chat-0")).not.toHaveProperty("inference");
});

it("does not use native-only rows to satisfy the released chat catalog floor", async () => {
  const { files, run } = fixture(199);
  await expect(run()).rejects.toThrow("below required floor");
  expect(files.some((file) => fs.existsSync(file))).toBe(false);
});
