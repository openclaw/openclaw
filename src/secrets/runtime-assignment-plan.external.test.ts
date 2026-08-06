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
  it("does not import an external channel entrypoint", async () => {
    const pluginId = "throwing-channel-preflight";
    const markerPath = path.join(os.tmpdir(), `${pluginId}-${Date.now()}.marker`);
    fixtureFiles.push(markerPath);
    const rootDir = createExternalPluginFixture({
      id: pluginId,
      entrypoint: `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(markerPath)}, "imported");
throw new Error("external channel entrypoint was imported");\n`,
      manifest: { channels: [pluginId] },
    });
    const config = {
      channels: { [pluginId]: { enabled: true } },
      plugins: {
        load: { paths: [rootDir] },
        entries: { [pluginId]: { enabled: true } },
      },
    } as OpenClawConfig;

    const plan = await buildActiveSecretsRuntimePreflightPlan({
      config,
      agentDirs: [path.join(rootDir, "agent")],
      loadAuthStore: emptyAuthStore,
    });

    expect(plan.refs).toEqual([]);
    expect(fs.existsSync(markerPath)).toBe(false);
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
