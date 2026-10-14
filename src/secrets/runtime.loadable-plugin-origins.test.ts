/** Tests secrets runtime loadable plugin origin detection. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

const manifestMocks = vi.hoisted(() => ({
  listPluginOriginsFromMetadataSnapshot: vi.fn(
    (snapshot: { plugins: Array<{ id: string; origin: string }> }) =>
      new Map(snapshot.plugins.map((record) => [record.id, record.origin])),
  ),
  loadPluginMetadataSnapshot: vi.fn<() => { plugins: Array<{ id: string; origin: string }> }>(
    () => ({
      plugins: [],
    }),
  ),
}));

vi.mock("./runtime-manifest.runtime.js", () => ({
  listPluginOriginsFromMetadataSnapshot: manifestMocks.listPluginOriginsFromMetadataSnapshot,
  resolveConfigWidePluginManifestRegistry: manifestMocks.loadPluginMetadataSnapshot,
}));

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();

describe("prepareSecretsRuntimeSnapshot loadable plugin origins", () => {
  afterEach(() => {
    manifestMocks.listPluginOriginsFromMetadataSnapshot.mockClear();
    manifestMocks.loadPluginMetadataSnapshot.mockReset();
    manifestMocks.loadPluginMetadataSnapshot.mockReturnValue({ plugins: [] });
  });

  it("keeps full plugin policy while projecting provider-auth assignments", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-runtime-secret-provider-"));
    fs.chmodSync(rootDir, 0o700);
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
    const resolverPath = path.join(rootDir, "resolve.mjs");
    fs.writeFileSync(
      resolverPath,
      [
        "import process from 'node:process';",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => input += chunk);",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(input);",
        "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values: Object.fromEntries(request.ids.map((id) => [id, `value:${id}`])) }));",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.chmodSync(resolverPath, 0o600);
    const plugin: PluginManifestRecord = {
      id: "vault-secrets",
      rootDir,
      source: path.join(rootDir, "index.ts"),
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
      origin: "global",
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    };
    const pluginMetadataSnapshot = {
      plugins: [plugin],
      manifestRegistry: {
        plugins: [plugin],
        diagnostics: [],
      },
    };

    try {
      const config = asConfig({
        plugins: {
          entries: {
            "vault-secrets": { enabled: true },
          },
        },
        gateway: {
          auth: {
            mode: "token",
            token: { source: "exec", provider: "vault", id: "gateway/token" },
          },
        },
        models: {
          providers: {
            openai: {
              apiKey: { source: "exec", provider: "vault", id: "models/openai" },
              models: [],
            },
          },
        },
        secrets: {
          providers: {
            vault: {
              source: "exec",
              pluginIntegration: {
                pluginId: "vault-secrets",
                integrationId: "vault",
              },
            },
          },
        },
      });
      const snapshot = await withSecureTestNodeExecPath(async () =>
        prepareSecretsRuntimeSnapshot({
          config,
          assignmentConfig: asConfig({
            models: config.models,
            secrets: config.secrets,
          }),
          env: { HOME: rootDir },
          includeAuthStoreRefs: false,
          pluginMetadataSnapshot,
        }),
      );

      expect(snapshot.config.gateway).toBeUndefined();
      expect(snapshot.config.models?.providers?.openai?.apiKey).toBe("value:models/openai");
      expect(manifestMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
      expect(manifestMocks.listPluginOriginsFromMetadataSnapshot).toHaveBeenCalledWith(
        pluginMetadataSnapshot.manifestRegistry,
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
