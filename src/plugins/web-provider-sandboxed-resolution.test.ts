/**
 * Covers sandboxed web provider resolution across both web provider contracts.
 * A workspace-origin plugin that declares `webSearchProviders` and
 * `webFetchProviders` must be rejected for a sandboxed agent on both paths.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { resolvePluginWebFetchProviders } from "./web-fetch-providers.runtime.js";
import { resolvePluginWebSearchProviders } from "./web-search-providers.runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const UNTRUSTED_PLUGIN_BODY = `
const providerFields = (kind) => ({
  id: "untrusted",
  label: "Untrusted",
  hint: "untrusted " + kind + " provider",
  envVars: [],
  placeholder: "untrusted-...",
  signupUrl: "https://untrusted.example.invalid",
  credentialPath:
    "plugins.entries.untrusted-web.config." + (kind === "search" ? "webSearch" : "webFetch") + ".apiKey",
  getCredentialValue: () => undefined,
  setCredentialValue: () => {},
  createTool: () => ({ description: "untrusted", parameters: {}, execute: async () => ({}) }),
});

module.exports = {
  id: "untrusted-web",
  register(api) {
    api.registerWebSearchProvider(providerFields("search"));
    api.registerWebFetchProvider(providerFields("fetch"));
  },
};
`;

/** Writes the issue fixture: one workspace plugin declaring both web provider contracts. */
function writeUntrustedWebPlugin(workspaceDir: string): void {
  const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "untrusted-web");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "untrusted-web",
      contracts: { webSearchProviders: ["untrusted"], webFetchProviders: ["untrusted"] },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf-8",
  );
  fs.writeFileSync(path.join(pluginDir, "index.cjs"), UNTRUSTED_PLUGIN_BODY, "utf-8");
}

type WorkspaceFixture = {
  config: OpenClawConfig;
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
};

function createWorkspaceFixture(): WorkspaceFixture {
  const root = makeTempDir("openclaw-web-provider-sandbox-");
  const workspaceDir = path.join(root, "workspace");
  const bundledDir = path.join(root, "bundled");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(bundledDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeUntrustedWebPlugin(workspaceDir);
  return {
    config: {
      plugins: {
        allow: ["untrusted-web"],
        entries: { "untrusted-web": { enabled: true } },
      },
    },
    workspaceDir,
    env: {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_STATE_DIR: stateDir,
    },
  };
}

function resolveProviderKeys(params: { fixture: WorkspaceFixture; sandboxed?: boolean }): {
  search: string[];
  fetch: string[];
} {
  const { config, workspaceDir, env } = params.fixture;
  const resolverParams = {
    config,
    workspaceDir,
    env,
    ...(params.sandboxed === undefined ? {} : { sandboxed: params.sandboxed }),
  };
  return withEnv(env, () => ({
    search: resolvePluginWebSearchProviders(resolverParams).map(
      (provider) => `${provider.pluginId}:${provider.id}`,
    ),
    fetch: resolvePluginWebFetchProviders(resolverParams).map(
      (provider) => `${provider.pluginId}:${provider.id}`,
    ),
  }));
}

describe("sandboxed web provider resolution", () => {
  it("rejects workspace web providers for search and fetch when sandboxed", () => {
    const fixture = createWorkspaceFixture();

    expect(resolveProviderKeys({ fixture, sandboxed: true })).toEqual({
      search: [],
      fetch: [],
    });
  });

  it("keeps workspace web providers for search and fetch when not sandboxed", () => {
    const fixture = createWorkspaceFixture();

    expect(resolveProviderKeys({ fixture, sandboxed: false })).toEqual({
      search: ["untrusted-web:untrusted"],
      fetch: ["untrusted-web:untrusted"],
    });
    expect(resolveProviderKeys({ fixture })).toEqual({
      search: ["untrusted-web:untrusted"],
      fetch: ["untrusted-web:untrusted"],
    });
  });

  it("does not fall back to another provider when a sandboxed agent configures an untrusted one", () => {
    const fixture = createWorkspaceFixture();
    const configured: WorkspaceFixture = {
      ...fixture,
      config: {
        ...fixture.config,
        tools: { web: { search: { provider: "untrusted" }, fetch: { provider: "untrusted" } } },
      },
    };

    expect(resolveProviderKeys({ fixture: configured, sandboxed: true })).toEqual({
      search: [],
      fetch: [],
    });
    expect(resolveProviderKeys({ fixture: configured })).toEqual({
      search: ["untrusted-web:untrusted"],
      fetch: ["untrusted-web:untrusted"],
    });
  });
});
