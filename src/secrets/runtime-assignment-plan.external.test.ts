/** Proves config-plane secret planning never evaluates external plugin runtime. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildActiveSecretsRuntimePreflightPlan } from "./runtime-assignment-plan.js";

const fixtureRoots: string[] = [];
const fixtureFiles: string[] = [];

function createExternalPluginFixture(params: {
  id: string;
  entrypoint: string;
  manifest: Record<string, unknown>;
  secretContract?: string;
}): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), `openclaw-${params.id}-`));
  fixtureRoots.push(rootDir);
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({
      name: `@test/${params.id}`,
      private: true,
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: params.id,
      configSchema: { type: "object", additionalProperties: true },
      ...params.manifest,
    })}\n`,
  );
  fs.writeFileSync(path.join(rootDir, "index.js"), params.entrypoint);
  if (params.secretContract) {
    fs.writeFileSync(path.join(rootDir, "secret-contract-api.cjs"), params.secretContract);
  }
  return rootDir;
}

function emptyAuthStore() {
  return { version: 1 as const, profiles: {} };
}

afterEach(() => {
  for (const rootDir of fixtureRoots.splice(0)) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
  for (const pathname of fixtureFiles.splice(0)) {
    fs.rmSync(pathname, { force: true });
  }
});

describe("active secrets runtime preflight external plugins", () => {
  it("does not import an external channel entrypoint or secret-contract sidecar", async () => {
    const pluginId = "throwing-channel-preflight";
    const entrypointMarkerPath = path.join(os.tmpdir(), `${pluginId}-${Date.now()}-entry.marker`);
    const contractMarkerPath = path.join(os.tmpdir(), `${pluginId}-${Date.now()}-contract.marker`);
    fixtureFiles.push(entrypointMarkerPath, contractMarkerPath);
    const rootDir = createExternalPluginFixture({
      id: pluginId,
      entrypoint: `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(entrypointMarkerPath)}, "imported");
throw new Error("external channel entrypoint was imported");\n`,
      secretContract: `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(contractMarkerPath)}, "imported");
throw new Error("external channel secret contract was imported");\n`,
      manifest: {
        channels: [pluginId],
        configContracts: {
          secretInputs: { paths: [{ path: "credential", expected: "string" }] },
        },
      },
    });
    const activeRef = {
      source: "exec" as const,
      provider: "vault",
      id: "channel/plugin-owned-credential",
    };
    const config = {
      channels: { [pluginId]: { enabled: true } },
      plugins: {
        load: { paths: [rootDir] },
        entries: { [pluginId]: { enabled: true, config: { credential: activeRef } } },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: process.execPath },
        },
      },
    } as OpenClawConfig;

    const plan = await buildActiveSecretsRuntimePreflightPlan({
      config,
      agentDirs: [path.join(rootDir, "agent")],
      loadAuthStore: emptyAuthStore,
    });

    expect(plan.refs).toEqual([activeRef]);
    expect(fs.existsSync(entrypointMarkerPath)).toBe(false);
    expect(fs.existsSync(contractMarkerPath)).toBe(false);
  });

  it("collects a manifest-declared external web ref without registering its plugin", async () => {
    const pluginId = "throwing-web-preflight";
    const markerPath = path.join(os.tmpdir(), `${pluginId}-${Date.now()}.marker`);
    fixtureFiles.push(markerPath);
    const rootDir = createExternalPluginFixture({
      id: pluginId,
      entrypoint: `import fs from "node:fs";
export default {
  id: ${JSON.stringify(pluginId)},
  register() {
    fs.writeFileSync(${JSON.stringify(markerPath)}, "registered");
    throw new Error("external web provider register callback ran");
  }
};\n`,
      manifest: {
        contracts: { webSearchProviders: ["throwing-search"] },
        configContracts: {
          secretInputs: { paths: [{ path: "webSearch.apiKey", expected: "string" }] },
        },
      },
    });
    const activeRef = {
      source: "exec" as const,
      provider: "vault",
      id: "web/search/api-key",
    };
    const config = {
      tools: { web: { search: { enabled: true, provider: "throwing-search" } } },
      plugins: {
        load: { paths: [rootDir] },
        entries: {
          [pluginId]: {
            enabled: true,
            config: { webSearch: { apiKey: activeRef } },
          },
        },
      },
      secrets: {
        providers: {
          vault: { source: "exec", command: process.execPath },
        },
      },
    } as OpenClawConfig;

    const plan = await buildActiveSecretsRuntimePreflightPlan({
      config,
      agentDirs: [path.join(rootDir, "agent")],
      loadAuthStore: emptyAuthStore,
    });

    expect(plan.refs).toEqual([activeRef]);
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
