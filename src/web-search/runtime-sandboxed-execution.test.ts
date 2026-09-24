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

const BUNDLED_SEARCH_PLUGIN_BODY = `
module.exports = {
  id: "bundled-search",
  register(api) {
    api.registerWebSearchProvider({
      id: "bundled-search",
      label: "Bundled Search",
      hint: "bundled search provider",
      envVars: [],
      placeholder: "bundled-...",
      signupUrl: "https://bundled.example.invalid",
      credentialPath: "plugins.entries.bundled-search.config.webSearch.apiKey",
      getCredentialValue: () => undefined,
      setCredentialValue: () => {},
      createTool: () => ({
        description: "bundled",
        parameters: {},
        execute: async () => ({ results: ["bundled-answer"] }),
      }),
    });
  },
};
`;

function writeBundledSearchPlugin(bundledDir: string): void {
  const pluginDir = path.join(bundledDir, "bundled-search");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "bundled-search",
      contracts: { webSearchProviders: ["bundled-search"] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(pluginDir, "index.cjs"), BUNDLED_SEARCH_PLUGIN_BODY, "utf-8");
}

type ExecutionFixture = {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  sentinelPath: string;
  bundledDir: string;
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
    bundledDir,
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
    // The rejection explains the trust restriction and names the configured provider.
    expect(failure?.message ?? "").toContain('"untrusted"');
    expect(failure?.message ?? "").toContain("bundled or verified-official");
    // The provider tool never executed: rejection happened before provider I/O.
    expect(readSentinel(fixture.sentinelPath)).toEqual([]);
  });

  it("keeps the plain no-provider message when a sandboxed run has nothing configured", async () => {
    const fixture = createExecutionFixture();
    const unconfigured = { plugins: fixture.config.plugins } as OpenClawConfig;

    const failure = await withEnvAsync(fixture.env, () =>
      runWebSearch({
        config: unconfigured,
        preferInputConfig: true,
        preferRuntimeProviders: true,
        sandboxed: true,
        args: { query: "sandbox proof" },
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      ),
    );

    // Nothing configured to blame: the trust wording must not appear.
    expect(failure?.message).toBe("web_search is disabled or no provider is available.");
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

  it("runs a configured bundled provider when sandboxed", async () => {
    const fixture = createExecutionFixture();
    writeBundledSearchPlugin(fixture.bundledDir);
    const bundledConfig: OpenClawConfig = {
      plugins: {
        allow: ["bundled-search"],
        entries: { "bundled-search": { enabled: true } },
      },
      tools: { web: { search: { provider: "bundled-search" } } },
    } as OpenClawConfig;

    const result = await withEnvAsync(fixture.env, () =>
      runWebSearch({
        config: bundledConfig,
        preferInputConfig: true,
        preferRuntimeProviders: true,
        sandboxed: true,
        args: { query: "sandbox proof" },
      }),
    );

    // Bundled providers are sandbox-eligible, so this selection must execute rather than be blamed.
    expect(result.provider).toBe("bundled-search");
  });

  it("does not blame the trust rule when the configured bundled provider is unavailable", async () => {
    const fixture = createExecutionFixture();
    writeBundledSearchPlugin(fixture.bundledDir);
    // Same eligible selection, but its plugin is disabled: the empty candidate set is availability,
    // not a sandbox rejection.
    const disabledConfig: OpenClawConfig = {
      plugins: {
        allow: ["bundled-search"],
        entries: { "bundled-search": { enabled: false } },
      },
      tools: { web: { search: { provider: "bundled-search" } } },
    } as OpenClawConfig;

    const failure = await withEnvAsync(fixture.env, () =>
      runWebSearch({
        config: disabledConfig,
        preferInputConfig: true,
        preferRuntimeProviders: true,
        sandboxed: true,
        args: { query: "sandbox proof" },
      }).then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      ),
    );

    // The provider already qualifies under the trust rule, so the recovery hint must point at the
    // plugin's availability and must not prescribe switching to a bundled or verified-official one.
    expect(failure?.message ?? "").toContain('"bundled-search"');
    expect(failure?.message ?? "").toContain("confirm its plugin is enabled");
    expect(failure?.message ?? "").not.toContain("bundled or verified-official");
    expect(readSentinel(fixture.sentinelPath)).toEqual([]);
  });
});
