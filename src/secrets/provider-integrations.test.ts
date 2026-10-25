/** Tests plugin-provided secret provider integration presets and resolution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import type { PluginManifestSecretProviderIntegration } from "../plugins/manifest.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { createPluginSecretProviderFixture } from "./plugin-secret-provider.test-support.js";
import {
  listSecretProviderIntegrationPresets,
  resolveSecretProviderIntegrationConfig,
} from "./provider-integrations.js";
import { resolveSecretRefString } from "./resolve.js";

const tempDirs: string[] = [];
const originalVersions = Object.getOwnPropertyDescriptor(process, "versions")!;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-secret-provider-integrations-"));
  fs.chmodSync(dir, 0o700);
  tempDirs.push(dir);
  return dir;
}

function makeSecureDir(dir: string): void {
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o700);
}

function writeSecureFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, "utf8");
  fs.chmodSync(file, 0o600);
}

function writeResolver(rootDir: string, relativePath = "bin/resolve.mjs") {
  const file = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeSecureFile(file, "process.stdin.resume();\n");
}

function createCandidate(
  rootDir: string,
  idHint: string,
  origin: PluginOrigin = "global",
): PluginCandidate {
  return { idHint, source: path.join(rootDir, "index.ts"), rootDir, origin };
}

function loadTestRegistry(
  rootDir: string,
  idHint = "vault-secrets",
  origin: PluginOrigin = "global",
): PluginManifestRegistry {
  return loadPluginManifestRegistryCore({
    candidates: [createCandidate(rootDir, idHint, origin)],
  });
}

function pluginIntegrationProviderConfig(pluginId: string, integrationId: string) {
  return { source: "exec" as const, pluginIntegration: { pluginId, integrationId } };
}

function writeIntegration(
  rootDir: string,
  integration: Omit<Partial<PluginManifestSecretProviderIntegration>, "command"> & {
    command?: string;
    allowInsecurePath?: boolean;
  } = {},
  id = "vault-secrets",
  integrationId = "vault",
  manifest: Record<string, unknown> = {},
) {
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      ...manifest,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      secretProviderIntegrations: {
        [integrationId]: {
          source: "exec",
          command: "${node}",
          args: ["./bin/resolve.mjs"],
          ...integration,
        },
      },
    }),
    "utf8",
  );
}

function resolveIntegration(
  manifestRegistry: Pick<PluginManifestRegistry, "plugins">,
  pluginId = "vault-secrets",
  integrationId = "vault",
) {
  return resolveSecretProviderIntegrationConfig({
    manifestRegistry,
    providerAlias: integrationId,
    providerConfig: pluginIntegrationProviderConfig(pluginId, integrationId),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(process, "versions", originalVersions);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret provider integration presets", () => {
  it("materializes exec providers with Bun runtime flags", () => {
    Object.defineProperty(process, "versions", {
      configurable: true,
      value: { ...process.versions, bun: "1.4.3" },
    });
    const rootDir = makeTempDir();
    writeResolver(rootDir);
    const options = {
      providerAlias: "acme",
      displayName: "Acme Vault",
      description: "Acme exec resolver",
      args: ["./bin/resolve.mjs", "--profile", "work"],
      timeoutMs: 3000,
      noOutputTimeoutMs: 3000,
      maxOutputBytes: 4096,
      passEnv: ["HOME"],
      env: {
        ACME_PROFILE: "work",
      },
      jsonOnly: false,
      allowInsecurePath: true,
    };
    writeIntegration(rootDir, options, "acme-secrets", "acme", { name: "Acme Secrets" });

    const registry = loadTestRegistry(rootDir, "acme-secrets");

    expect(registry.diagnostics).toEqual([]);
    expect(registry.plugins[0]?.secretProviderIntegrations?.acme).not.toHaveProperty(
      "allowInsecurePath",
    );
    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "acme",
        pluginId: "acme-secrets",
        providerAlias: "acme",
        displayName: "Acme Vault",
        description: "Acme exec resolver",
        providerConfig: pluginIntegrationProviderConfig("acme-secrets", "acme"),
      },
    ]);
    expect(resolveIntegration(registry, "acme-secrets", "acme")).toEqual({
      ok: true,
      providerConfig: {
        source: "exec",
        command: process.execPath,
        args: [
          "--no-install",
          fs.realpathSync(path.join(rootDir, "bin", "resolve.mjs")),
          "--profile",
          "work",
        ],
        timeoutMs: 3000,
        noOutputTimeoutMs: 3000,
        maxOutputBytes: 4096,
        passEnv: ["HOME"],
        env: { ACME_PROFILE: "work" },
        trustedDirs: [path.dirname(process.execPath), rootDir],
        jsonOnly: false,
      },
    });
  });

  it.each(["plugin", "integration"] as const)("skips presets with overlong %s IDs", (field) => {
    const rootDir = makeTempDir();
    const longId = `${field}-${"x".repeat(129)}`;
    const pluginId = field === "plugin" ? longId : "vault-secrets";
    const integrationId = field === "integration" ? longId : "vault";
    writeResolver(rootDir);
    writeIntegration(rootDir, { providerAlias: "short-alias" }, pluginId, integrationId);
    expect(
      listSecretProviderIntegrationPresets({
        manifestRegistry: loadTestRegistry(rootDir, pluginId),
      }),
    ).toEqual([]);
  });

  it("skips non-node manifest preset commands for global plugin roots", () => {
    const rootDir = makeTempDir();
    writeIntegration(rootDir, {
      providerAlias: "vault",
      command: "./bin/vault-resolver",
      args: undefined,
    });

    const registry = loadTestRegistry(rootDir);

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it("skips secret provider presets from workspace plugin roots", () => {
    const rootDir = makeTempDir();
    writeIntegration(rootDir, {
      providerAlias: "vault",
      args: ["./resolve.mjs"],
    });

    const registry = loadTestRegistry(rootDir, "vault-secrets", "workspace");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it("fails closed when a plugin-managed provider is disabled", async () => {
    const { rootDir, config, manifestRegistry } = createPluginSecretProviderFixture();
    tempDirs.push(rootDir);
    config.plugins = { entries: { "vault-secrets": { enabled: false } } };
    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
        { config, manifestRegistry },
      ),
    ).rejects.toThrow("plugin integration is unavailable");
  });

  it("does not materialize non-node integrations from registry records", () => {
    const { rootDir, manifestRegistry } = createPluginSecretProviderFixture();
    tempDirs.push(rootDir);
    const plugin = expectDefined(manifestRegistry.plugins[0], "fixture plugin");
    expectDefined(plugin.secretProviderIntegrations?.vault, "fixture integration").command =
      "./resolve.mjs";
    expect(resolveIntegration(manifestRegistry)).toEqual({
      ok: false,
      reason: 'plugin "vault-secrets" integration "vault" could not be materialized',
    });
  });

  it("skips node presets without a plugin-root relative entrypoint arg", () => {
    const rootDir = makeTempDir();
    writeIntegration(
      rootDir,
      {
        args: ["--import", "./bin/hook.mjs", "./bin/resolve.mjs"],
      },
      "vault-secrets",
      "bad",
    );

    const registry = loadTestRegistry(rootDir);

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "skips node presets whose entrypoint symlink leaves the plugin root",
    () => {
      const rootDir = makeTempDir();
      const outsideDir = makeTempDir();
      fs.mkdirSync(path.join(rootDir, "bin"));
      fs.writeFileSync(path.join(outsideDir, "resolve.mjs"), "process.stdin.resume();\n");
      fs.symlinkSync(
        path.join(outsideDir, "resolve.mjs"),
        path.join(rootDir, "bin", "resolve.mjs"),
      );
      writeIntegration(rootDir, { providerAlias: "vault" });

      const registry = loadTestRegistry(rootDir);

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("allows node presets from symlinked plugin roots", () => {
    const parentDir = makeTempDir();
    const realRoot = path.join(parentDir, "real-plugin");
    const linkedRoot = path.join(parentDir, "linked-plugin");
    makeSecureDir(realRoot);
    fs.symlinkSync(realRoot, linkedRoot, "dir");
    writeResolver(realRoot);
    writeIntegration(realRoot, { providerAlias: "vault" });

    const registry = loadTestRegistry(linkedRoot);

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      expect.objectContaining({ displayName: "vault" }),
    ]);
    const resolved = resolveIntegration(registry);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.providerConfig.args?.at(-1)).toBe(
        fs.realpathSync(path.join(realRoot, "bin", "resolve.mjs")),
      );
    }
    const integration = registry.plugins[0]?.secretProviderIntegrations?.vault;
    if (!integration) {
      throw new Error("Expected the linked-root integration");
    }
    integration.args = ["./../real-plugin/bin/resolve.mjs"];
    expect(resolveIntegration(registry).ok).toBe(false);
  });

  it.each([false, true])(
    "preserves platform policy for entrypoint parent links (outside root: %s)",
    (outsideRoot) => {
      const rootDir = makeTempDir();
      const targetDir = path.join(outsideRoot ? makeTempDir() : rootDir, "resolver");
      writeResolver(targetDir, "resolve.mjs");
      fs.symlinkSync(
        targetDir,
        path.join(rootDir, "bin"),
        process.platform === "win32" ? "junction" : "dir",
      );
      writeIntegration(rootDir);

      const resolved = resolveIntegration(loadTestRegistry(rootDir));
      expect(resolved.ok).toBe(process.platform === "win32" && !outsideRoot);
      if (resolved.ok) {
        expect(resolved.providerConfig.args?.at(-1)).toBe(
          fs.realpathSync(path.join(targetDir, "resolve.mjs")),
        );
      }
    },
  );

  it.each<PluginOrigin>(["global", "bundled"])(
    "preserves the hardlinked entrypoint policy for %s plugins",
    (origin) => {
      const rootDir = makeTempDir();
      const sourcePath = path.join(rootDir, "source.mjs");
      writeResolver(rootDir, "source.mjs");
      fs.linkSync(sourcePath, path.join(rootDir, "resolve.mjs"));
      writeIntegration(
        rootDir,
        { args: ["./resolve.mjs"] },
        "vault-secrets",
        "vault",
        origin === "bundled" ? { enabledByDefault: true } : {},
      );

      const resolved = resolveIntegration(loadTestRegistry(rootDir, "vault-secrets", origin));
      expect(resolved.ok).toBe(origin === "bundled");
    },
  );

  it.skipIf(process.platform === "win32").each([
    { writable: "world", dirMode: 0o777, fileMode: 0o644, presets: 0 },
    { writable: "group", dirMode: 0o775, fileMode: 0o664, presets: 1 },
  ])(
    "lists $presets preset(s) when the node entrypoint path is $writable-writable",
    ({ dirMode, fileMode, presets }) => {
      const rootDir = makeTempDir();
      const binDir = path.join(rootDir, "bin");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "resolve.mjs"), "process.stdin.resume();\n");
      fs.chmodSync(path.join(binDir, "resolve.mjs"), fileMode);
      fs.chmodSync(binDir, dirMode);
      try {
        writeIntegration(rootDir, { providerAlias: "vault" });

        const registry = loadTestRegistry(rootDir);

        expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toHaveLength(
          presets,
        );
      } finally {
        fs.chmodSync(binDir, 0o700);
      }
    },
  );
});

it.each([true, false])(
  "admits only the exact embedded plugin resolver when its disk file is pruned: %s",
  (embedded) => {
    const rootDir = makeTempDir();
    const target = path.join(rootDir, "resolve.js");
    writeIntegration(rootDir, {
      providerAlias: "vault",
      args: ["./resolve.js", "--profile", "test"],
    });
    vi.stubGlobal(
      "__openclawStandaloneIsEmbeddedModule",
      (filename: string) => filename === (embedded ? target : path.join(rootDir, "different.js")),
    );
    const result = resolveIntegration(loadTestRegistry(rootDir));
    expect(fs.existsSync(target)).toBe(false);
    expect(result.ok).toBe(embedded);
    if (result.ok) {
      expect(result.providerConfig.args).toEqual(
        expect.arrayContaining([target, "--profile", "test"]),
      );
    }
  },
);
