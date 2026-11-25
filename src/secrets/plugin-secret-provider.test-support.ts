import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";

export function createPluginSecretProviderFixture() {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-secret-provider-"));
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
    secretProviderIntegrations: vaultSecretProviderIntegrations("./resolve.mjs", "vault"),
  };
  const config: OpenClawConfig = {
    secrets: {
      providers: {
        vault: {
          source: "exec",
          pluginIntegration: { pluginId: plugin.id, integrationId: "vault" },
        },
      },
    },
  };
  return { config, rootDir, manifestRegistry: { plugins: [plugin], diagnostics: [] } };
}

export function vaultSecretProviderIntegrations(
  entrypoint: string,
  providerAlias: string,
): NonNullable<PluginManifestRecord["secretProviderIntegrations"]> {
  return {
    vault: {
      providerAlias,
      source: "exec",
      command: "${node}",
      args: [entrypoint],
    },
  };
}
