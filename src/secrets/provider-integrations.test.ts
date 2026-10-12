/** Tests plugin-provided secret provider integration presets and resolution. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginCandidate } from "../plugins/discovery.js";
import {
  loadPluginManifestRegistryCore,
  type PluginManifestRegistry,
} from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import {
  listSecretProviderIntegrationPresets,
  resolveSecretProviderIntegrationConfig,
} from "./provider-integrations.js";
import { resolveSecretRefString } from "./resolve.js";
import { withSecureTestNodeExecPath } from "./test-node-command.test-support.js";

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

function writePluginManifest(rootDir: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      ...manifest,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    }),
    "utf8",
  );
}

function createCandidate(
  rootDir: string,
  idHint: string,
  origin: PluginOrigin = "global",
): PluginCandidate {
  return {
    idHint,
    source: path.join(rootDir, "index.ts"),
    rootDir,
    origin,
  };
}

function loadTestRegistry(
  rootDir: string,
  idHint: string,
  origin: PluginOrigin = "global",
): PluginManifestRegistry {
  return loadPluginManifestRegistryCore({
    candidates: [createCandidate(rootDir, idHint, origin)],
  });
}

function pluginIntegrationProviderConfig(pluginId: string, integrationId: string) {
  return {
    source: "exec" as const,
    pluginIntegration: {
      pluginId,
      integrationId,
    },
  };
}

afterEach(() => {
  Object.defineProperty(process, "versions", originalVersions);
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("secret provider integration presets", () => {
  it.each(["1.4.3"])(
    "materializes exec providers with the selected runtime flags (Bun: %s)",
    (bun) => {
      Object.defineProperty(process, "versions", {
        configurable: true,
        value: { ...process.versions, bun },
      });
      const rootDir = makeTempDir();
      makeSecureDir(path.join(rootDir, "bin"));
      writeSecureFile(path.join(rootDir, "bin", "resolve.mjs"), "process.stdin.resume();\n");
      writePluginManifest(rootDir, {
        id: "acme-secrets",
        name: "Acme Secrets",
        secretProviderIntegrations: {
          acme: {
            providerAlias: "acme",
            displayName: "Acme Vault",
            description: "Acme exec resolver",
            source: "exec",
            command: "${node}",
            args: ["./bin/resolve.mjs", "--profile", "work"],
            timeoutMs: 3000,
            noOutputTimeoutMs: 3000,
            maxOutputBytes: 4096,
            passEnv: ["HOME"],
            env: {
              ACME_PROFILE: "work",
            },
            jsonOnly: false,
          },
        },
      });

      const registry = loadTestRegistry(rootDir, "acme-secrets");

      expect(registry.diagnostics).toEqual([]);
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
      expect(
        resolveSecretProviderIntegrationConfig({
          manifestRegistry: registry,
          providerAlias: "acme",
          providerConfig: pluginIntegrationProviderConfig("acme-secrets", "acme"),
        }),
      ).toEqual({
        ok: true,
        providerConfig: {
          source: "exec",
          command: process.execPath,
          args: [
            ...(bun ? ["--no-install"] : []),
            fs.realpathSync(path.join(rootDir, "bin", "resolve.mjs")),
            "--profile",
            "work",
          ],
          timeoutMs: 3000,
          noOutputTimeoutMs: 3000,
          maxOutputBytes: 4096,
          passEnv: ["HOME"],
          env: {
            ACME_PROFILE: "work",
          },
          trustedDirs: [path.dirname(process.execPath), rootDir],
          jsonOnly: false,
        },
      });
    },
  );

  it("skips presets whose persisted plugin integration IDs would violate config schema limits", () => {
    const rootDir = makeTempDir();
    const longPluginRootDir = makeTempDir();
    const longPluginId = `plugin-${"x".repeat(129)}`;
    const longIntegrationId = `integration-${"x".repeat(129)}`;
    fs.writeFileSync(path.join(rootDir, "resolve.mjs"), "process.stdin.resume();\n", "utf8");
    fs.writeFileSync(
      path.join(longPluginRootDir, "resolve.mjs"),
      "process.stdin.resume();\n",
      "utf8",
    );
    writePluginManifest(rootDir, {
      id: "long-integration-secrets",
      secretProviderIntegrations: {
        [longIntegrationId]: {
          providerAlias: "short-alias",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });
    writePluginManifest(longPluginRootDir, {
      id: longPluginId,
      secretProviderIntegrations: {
        vault: {
          providerAlias: "short-plugin-alias",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });

    const registry = loadPluginManifestRegistryCore({
      candidates: [
        createCandidate(rootDir, "long-integration-secrets"),
        createCandidate(longPluginRootDir, longPluginId),
      ],
    });

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
  });

  it.each<PluginOrigin>(["global"])(
    "skips non-node manifest preset commands for %s plugin roots",
    (origin) => {
      const rootDir = makeTempDir();
      fs.mkdirSync(path.join(rootDir, "bin"));
      writePluginManifest(rootDir, {
        id: `${origin}-secrets`,
        ...(origin === "bundled" ? { enabledByDefault: true } : {}),
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "./bin/vault-resolver",
          },
        },
      });

      const registry = loadTestRegistry(rootDir, `${origin}-secrets`, origin);

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it.each<PluginOrigin>(["workspace"])(
    "skips secret provider presets from %s plugin roots",
    (origin) => {
      const rootDir = makeTempDir();
      writePluginManifest(rootDir, {
        id: `${origin}-secrets`,
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "${node}",
            args: ["./resolve.mjs"],
          },
        },
      });

      const registry = loadTestRegistry(rootDir, `${origin}-secrets`, origin);

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it("resolves a node-based plugin preset with plugin trusted dirs", async () => {
    const rootDir = makeTempDir();
    const resolverPath = path.join(rootDir, "bin", "resolve.mjs");
    makeSecureDir(path.dirname(resolverPath));
    writeSecureFile(
      resolverPath,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(input);",
        "  const values = Object.fromEntries(request.ids.map((id) => [id, `value:${id}`]));",
        "  process.stdout.write(JSON.stringify({ protocolVersion: 1, values }));",
        "});",
      ].join("\n"),
    );
    writePluginManifest(rootDir, {
      id: "vault-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./bin/resolve.mjs"],
          allowInsecurePath: true,
        },
      },
    });

    await withSecureTestNodeExecPath(async () => {
      const registry = loadTestRegistry(rootDir, "vault-secrets", "global");
      expect(registry.plugins[0]?.secretProviderIntegrations?.vault).not.toHaveProperty(
        "allowInsecurePath",
      );
      const [preset] = listSecretProviderIntegrationPresets({ manifestRegistry: registry });
      if (!preset) {
        throw new Error("Expected vault preset");
      }

      expect(preset.providerConfig).toEqual({
        source: "exec",
        pluginIntegration: {
          pluginId: "vault-secrets",
          integrationId: "vault",
        },
      });
      await expect(
        resolveSecretRefString(
          { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
          {
            config: {
              secrets: {
                providers: {
                  vault: preset.providerConfig,
                },
              },
            },
            manifestRegistry: registry,
          },
        ),
      ).resolves.toBe("value:providers/openrouter/apiKey");
    });
  });

  it("fails closed when a plugin-managed provider is disabled", async () => {
    const rootDir = makeTempDir();
    const resolverPath = path.join(rootDir, "resolve.mjs");
    fs.writeFileSync(resolverPath, "process.stdin.resume();\n", "utf8");
    writePluginManifest(rootDir, {
      id: "revoked-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./resolve.mjs"],
        },
      },
    });
    const config = {
      plugins: {
        entries: {
          "revoked-secrets": {
            enabled: false,
          },
        },
      },
      secrets: {
        providers: {
          vault: pluginIntegrationProviderConfig("revoked-secrets", "vault"),
        },
      },
    };
    const registry = loadPluginManifestRegistryCore({
      candidates: [createCandidate(rootDir, "revoked-secrets", "global")],
      config,
    });

    await expect(
      resolveSecretRefString(
        { source: "exec", provider: "vault", id: "providers/openrouter/apiKey" },
        {
          config,
          manifestRegistry: registry,
        },
      ),
    ).rejects.toThrow("plugin integration is unavailable");
  });

  it("does not materialize non-node integrations from registry records", () => {
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, "bin"));
    fs.writeFileSync(path.join(rootDir, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(rootDir, "bin", "resolve"), "exit 0\n", "utf8");
    const manifestRegistry = {
      plugins: [
        {
          id: "raw-secrets",
          rootDir,
          origin: "global",
          channels: [],
          providers: [],
          cliBackends: [],
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              source: "exec",
              command: "./bin/resolve",
            },
          },
        },
      ],
    } as unknown as Pick<PluginManifestRegistry, "plugins">;

    expect(
      resolveSecretProviderIntegrationConfig({
        manifestRegistry,
        providerAlias: "vault",
        providerConfig: pluginIntegrationProviderConfig("raw-secrets", "vault"),
      }),
    ).toEqual({
      ok: false,
      reason: 'plugin "raw-secrets" integration "vault" could not be materialized',
    });
  });

  it("skips node presets without a plugin-root relative entrypoint arg", () => {
    const rootDir = makeTempDir();
    writePluginManifest(rootDir, {
      id: "bad-trust-secrets",
      secretProviderIntegrations: {
        bad: {
          source: "exec",
          command: "${node}",
          args: ["--import", "./bin/hook.mjs", "./bin/resolve.mjs"],
        },
      },
    });

    const registry = loadTestRegistry(rootDir, "bad-trust-secrets");

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
      writePluginManifest(rootDir, {
        id: "symlink-secrets",
        secretProviderIntegrations: {
          vault: {
            providerAlias: "vault",
            source: "exec",
            command: "${node}",
            args: ["./bin/resolve.mjs"],
          },
        },
      });

      const registry = loadTestRegistry(rootDir, "symlink-secrets");

      expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("allows node presets from symlinked plugin roots", () => {
    const parentDir = makeTempDir();
    const realRoot = path.join(parentDir, "real-plugin");
    const linkedRoot = path.join(parentDir, "linked-plugin");
    makeSecureDir(realRoot);
    fs.symlinkSync(realRoot, linkedRoot, "dir");
    makeSecureDir(path.join(realRoot, "bin"));
    writeSecureFile(path.join(realRoot, "bin", "resolve.mjs"), "process.stdin.resume();\n");
    writePluginManifest(realRoot, {
      id: "linked-root-secrets",
      secretProviderIntegrations: {
        vault: {
          providerAlias: "vault",
          source: "exec",
          command: "${node}",
          args: ["./bin/resolve.mjs"],
        },
      },
    });

    const registry = loadTestRegistry(linkedRoot, "linked-root-secrets");

    expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([
      {
        id: "vault",
        pluginId: "linked-root-secrets",
        providerAlias: "vault",
        displayName: "vault",
        providerConfig: pluginIntegrationProviderConfig("linked-root-secrets", "vault"),
      },
    ]);
    const resolved = resolveSecretProviderIntegrationConfig({
      manifestRegistry: registry,
      providerAlias: "vault",
      providerConfig: pluginIntegrationProviderConfig("linked-root-secrets", "vault"),
    });
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
    expect(
      resolveSecretProviderIntegrationConfig({
        manifestRegistry: registry,
        providerAlias: "vault",
        providerConfig: pluginIntegrationProviderConfig("linked-root-secrets", "vault"),
      }).ok,
    ).toBe(false);
  });

  it.each([false, true])(
    "preserves platform policy for entrypoint parent links (outside root: %s)",
    (outsideRoot) => {
      const rootDir = makeTempDir();
      const targetDir = path.join(outsideRoot ? makeTempDir() : rootDir, "resolver");
      makeSecureDir(targetDir);
      writeSecureFile(path.join(targetDir, "resolve.mjs"), "process.stdin.resume();\n");
      fs.symlinkSync(
        targetDir,
        path.join(rootDir, "bin"),
        process.platform === "win32" ? "junction" : "dir",
      );
      writePluginManifest(rootDir, {
        id: "parent-link-secrets",
        secretProviderIntegrations: {
          vault: {
            source: "exec",
            command: "${node}",
            args: ["./bin/resolve.mjs"],
          },
        },
      });

      const resolved = resolveSecretProviderIntegrationConfig({
        manifestRegistry: loadTestRegistry(rootDir, "parent-link-secrets"),
        providerAlias: "vault",
        providerConfig: pluginIntegrationProviderConfig("parent-link-secrets", "vault"),
      });
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
      writeSecureFile(sourcePath, "process.stdin.resume();\n");
      fs.linkSync(sourcePath, path.join(rootDir, "resolve.mjs"));
      writePluginManifest(rootDir, {
        id: "hardlinked-secrets",
        ...(origin === "bundled" ? { enabledByDefault: true } : {}),
        secretProviderIntegrations: {
          vault: {
            source: "exec",
            command: "${node}",
            args: ["./resolve.mjs"],
          },
        },
      });

      const resolved = resolveSecretProviderIntegrationConfig({
        manifestRegistry: loadTestRegistry(rootDir, "hardlinked-secrets", origin),
        providerAlias: "vault",
        providerConfig: pluginIntegrationProviderConfig("hardlinked-secrets", "vault"),
      });
      expect(resolved.ok).toBe(origin === "bundled");
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips node presets whose entrypoint parent directory is writable by others",
    () => {
      const rootDir = makeTempDir();
      const binDir = path.join(rootDir, "bin");
      fs.mkdirSync(binDir);
      fs.writeFileSync(path.join(binDir, "resolve.mjs"), "process.stdin.resume();\n");
      fs.chmodSync(binDir, 0o777);
      try {
        writePluginManifest(rootDir, {
          id: "writable-parent-secrets",
          secretProviderIntegrations: {
            vault: {
              providerAlias: "vault",
              source: "exec",
              command: "${node}",
              args: ["./bin/resolve.mjs"],
            },
          },
        });

        const registry = loadTestRegistry(rootDir, "writable-parent-secrets");

        expect(listSecretProviderIntegrationPresets({ manifestRegistry: registry })).toEqual([]);
      } finally {
        fs.chmodSync(binDir, 0o700);
      }
    },
  );
});
