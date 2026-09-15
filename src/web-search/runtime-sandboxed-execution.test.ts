/**
 * Real-execution proof for the sandboxed web_search provider trust filter.
 * Drives the registered `runWebSearch` entrypoint (default lazy runtime path,
 * `preferRuntimeProviders: true`) against a real on-disk workspace plugin and
 * observes whether provider I/O happens via an execute sentinel file.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runWebSearch } from "./runtime.js";

const SENTINEL_ENV_KEY = "OPENCLAW_TEST_UNTRUSTED_SEARCH_IO_SENTINEL";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await clearActivePluginRegistry();
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const UNTRUSTED_PLUGIN_BODY = `
const fs = require("node:fs");
module.exports = {
  id: "untrusted-web",
  register(api) {
    api.registerWebSearchProvider({
      id: "untrusted",
      label: "Untrusted",
      hint: "untrusted search provider",
      envVars: [],
      placeholder: "untrusted-...",
      signupUrl: "https://untrusted.example.invalid",
      credentialPath: "plugins.entries.untrusted-web.config.webSearch.apiKey",
      getCredentialValue: () => undefined,
      setCredentialValue: () => {},
      createTool: () => ({
        description: "untrusted",
        parameters: {},
        execute: async (args) => {
          fs.appendFileSync(
            process.env.${SENTINEL_ENV_KEY},
            "search-executed:" + JSON.stringify(args?.query ?? null) + "\\n",
          );
          return { results: ["untrusted-answer"] };
        },
      }),
    });
  },
};
`;

function writeUntrustedWebPlugin(workspaceDir: string): void {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "untrusted-web");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "untrusted-web",
      contracts: { webSearchProviders: ["untrusted"] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(pluginDir, "index.cjs"), UNTRUSTED_PLUGIN_BODY, "utf-8");
}

type ExecutionFixture = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  sentinelPath: string;
};

function createExecutionFixture(): ExecutionFixture {
  const root = makeTempDir("openclaw-web-search-sandbox-exec-");
  const workspaceDir = path.join(root, "workspace");
  const bundledDir = path.join(root, "bundled");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeUntrustedWebPlugin(workspaceDir);
  const sentinelPath = path.join(root, "provider-io.log");
  // Existing-configuration shape: the workspace already selects the
  // third-party provider, as before this fix was enforced.
  const config: OpenClawConfig = {
    plugins: {
      allow: ["untrusted-web"],
      entries: { "untrusted-web": { enabled: true } },
    },
    tools: { web: { search: { provider: "untrusted" } } },
  } as OpenClawConfig;
  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    `sandbox-exec-proof-${path.basename(root)}`,
    "default",
    workspaceDir,
  );
  return {
    config,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_STATE_DIR: stateDir,
      [SENTINEL_ENV_KEY]: sentinelPath,
    },
    sentinelPath,
  };
}

function readSentinel(sentinelPath: string): string[] {
  if (!fs.existsSync(sentinelPath)) {
    return [];
  }
  return fs.readFileSync(sentinelPath, "utf-8").split("\n").filter(Boolean);
}

describe("sandboxed web_search execution", () => {
  it("rejects the configured workspace provider before provider I/O when sandboxed", async () => {
    const fixture = createExecutionFixture();

    const failure = await withEnvAsync(fixture.env, () =>
      runWebSearch({
        config: fixture.config,
        preferInputConfig: true,
        preferRuntimeProviders: true,
        sandboxed: true,
        args: { query: "sandbox proof" },
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      ),
    );

    expect(failure?.message ?? "").toMatch(/disabled|no provider/i);
    // The provider tool never executed: rejection happened before provider I/O.
    expect(readSentinel(fixture.sentinelPath)).toEqual([]);
  });

  it("executes the same configured provider when not sandboxed", async () => {
    const fixture = createExecutionFixture();

    const result = await withEnvAsync(fixture.env, () =>
      runWebSearch({
        config: fixture.config,
        preferInputConfig: true,
        preferRuntimeProviders: true,
        args: { query: "sandbox proof" },
      }),
    );

    // Control: the fixture really loads, registers, and executes (non-vacuous).
    expect(result.provider).toBe("untrusted");
    expect(readSentinel(fixture.sentinelPath)).toEqual(['search-executed:"sandbox proof"']);
  });
});
