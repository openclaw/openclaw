import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectBundledProviderAuthEnvVars,
  writeBundledProviderAuthEnvVarModule,
} from "../../scripts/generate-bundled-provider-auth-env-vars.mjs";
import { BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES } from "./bundled-provider-auth-env-vars.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  pluginTestRepoRoot as repoRoot,
  writeJson,
} from "./generated-plugin-test-helpers.js";

installGeneratedPluginTempRootCleanup();

function expectGeneratedAuthEnvVarModuleState(params: {
  tempRoot: string;
  expectedChanged: boolean;
  expectedWrote: boolean;
}) {
  const result = writeBundledProviderAuthEnvVarModule({
    repoRoot: params.tempRoot,
    outputPath: "src/plugins/bundled-provider-auth-env-vars.generated.ts",
    check: true,
  });
  expect(result.changed).toBe(params.expectedChanged);
  expect(result.wrote).toBe(params.expectedWrote);
}

function expectBundledProviderEnvVars(expected: Record<string, readonly string[]>) {
  expect(
    Object.fromEntries(
      Object.keys(expected).map((providerId) => [
        providerId,
        BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES[
          providerId as keyof typeof BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES
        ],
      ]),
    ),
  ).toEqual(expected);
}

describe("bundled provider auth env vars", () => {
  it("matches the generated manifest snapshot", () => {
    expect(BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES).toEqual(
      collectBundledProviderAuthEnvVars({ repoRoot }),
    );
  });

  it("reads bundled provider auth env vars from plugin manifests", () => {
    expectBundledProviderEnvVars({
      brave: ["BRAVE_API_KEY"],
      firecrawl: ["FIRECRAWL_API_KEY"],
      "github-copilot": ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
      perplexity: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
      tavily: ["TAVILY_API_KEY"],
      "minimax-portal": ["MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
      openai: ["OPENAI_API_KEY"],
      fal: ["FAL_KEY"],
    });
    expect("openai-codex" in BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES).toBe(false);
  });

  it("supports check mode for stale generated artifacts", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-provider-auth-env-vars-");

    writeJson(path.join(tempRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      providerAuthEnvVars: {
        alpha: ["ALPHA_TOKEN"],
      },
    });

    const initial = writeBundledProviderAuthEnvVarModule({
      repoRoot: tempRoot,
      outputPath: "src/plugins/bundled-provider-auth-env-vars.generated.ts",
    });
    expect(initial.wrote).toBe(true);

    expectGeneratedAuthEnvVarModuleState({
      tempRoot,
      expectedChanged: false,
      expectedWrote: false,
    });

    fs.writeFileSync(
      path.join(tempRoot, "src/plugins/bundled-provider-auth-env-vars.generated.ts"),
      "// stale\n",
      "utf8",
    );

    expectGeneratedAuthEnvVarModuleState({
      tempRoot,
      expectedChanged: true,
      expectedWrote: false,
    });
  });
});
