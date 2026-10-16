import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hashJson } from "./installed-plugin-index-hash.js";
import { recordInstalledPluginIndexInstallOwner } from "./installed-plugin-index-install-owner.js";
import type { InstalledPluginIndex } from "./installed-plugin-index-types.js";

export const nativeSize = 2 * 1024 * 1024;

export function createFixture(
  directory: string,
  managed: boolean,
  source: "npm" | "clawhub" = "npm",
) {
  const installRoot = managed
    ? path.join(directory, "project", "node_modules", "fixture-package")
    : directory;
  const root = managed ? path.join(installRoot, "plugins", "fixture") : directory;
  fs.mkdirSync(root, { recursive: true });
  if (managed) {
    fs.writeFileSync(
      path.join(installRoot, "package.json"),
      JSON.stringify({
        name: "fixture-package",
        version: "1.0.0",
        openclaw: { extensions: ["./plugins/fixture/index.js"] },
      }),
    );
  }
  const manifestPath = path.join(root, "openclaw.plugin.json");
  const manifest = JSON.stringify({ id: "fixture", configSchema: { type: "object" } });
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  const entry = path.join(root, "index.js");
  fs.writeFileSync(entry, "export default { id: 'fixture', register() {} };\n");
  const filename = path.join(root, managed ? "fixture.bin" : "fixture.so");
  const bytes = Buffer.alloc(nativeSize, "A");
  fs.writeFileSync(filename, bytes);
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "2026.9.6",
    compatRegistryVersion: "compat-v1",
    migrationVersion: 1,
    policyHash: "fixture-policy",
    generatedAtMs: 1,
    installRecords: managed ? { "fixture-package": { source, installPath: installRoot } } : {},
    plugins: [
      recordInstalledPluginIndexInstallOwner<InstalledPluginIndex["plugins"][number]>(
        {
          pluginId: "fixture",
          manifestPath,
          manifestHash: createHash("sha256").update(manifest).digest("hex"),
          source: entry,
          ...(managed ? { installRecordHash: hashJson({ source, installPath: installRoot }) } : {}),
          rootDir: root,
          origin: "global",
          enabled: true,
          startup: { sidecar: false, memory: false, agentHarnesses: [] },
          compat: [],
        },
        managed ? "fixture-package" : undefined,
      ),
    ],
    diagnostics: [],
  };
  return { root, installRoot, entry, filename, bytes, index };
}
