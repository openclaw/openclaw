// Guards that StepFun's China (.com) endpoints resolve to the plugin catalog.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isProviderCatalogSourceAllowed } from "../plugins/provider-config-owner.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifest = parseJsonWithJson5Fallback(
  fs.readFileSync(path.join(repoRoot, "extensions/stepfun/openclaw.plugin.json"), "utf8"),
);
if (!isRecord(manifest)) {
  throw new Error("StepFun manifest did not parse to an object");
}

const plugin = {
  providerEndpoints: manifest.providerEndpoints as never,
  modelCatalog: manifest.modelCatalog as never,
};

function providerConfig(provider: string, baseUrl: string): OpenClawConfig {
  return { models: { providers: { [provider]: { baseUrl, models: [] } } } };
}

describe("StepFun provider catalog endpoint eligibility", () => {
  it.each([
    ["stepfun", "https://api.stepfun.com/v1"],
    ["stepfun", "https://api.stepfun.ai/v1"],
    ["stepfun-plan", "https://api.stepfun.com/step_plan/v1"],
    ["stepfun-plan", "https://api.stepfun.ai/step_plan/v1"],
  ])("owns the native %s endpoint %s across both regions", (provider, baseUrl) => {
    expect(
      isProviderCatalogSourceAllowed({
        provider,
        config: providerConfig(provider, baseUrl),
        plugin,
      }),
    ).toBe(true);
  });

  it("does not claim a proxy endpoint it never declared", () => {
    expect(
      isProviderCatalogSourceAllowed({
        provider: "stepfun",
        config: providerConfig("stepfun", "https://proxy.example/v1"),
        plugin,
      }),
    ).toBe(false);
  });
});
