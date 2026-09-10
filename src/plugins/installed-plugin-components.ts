import path from "node:path";
import type {
  PluginDeclaredSurface,
  PluginInstalledComponents,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { loadHookEntriesFromDir } from "../hooks/discovery.js";
import { resolvePluginSkillNames } from "../skills/loading/plugin-skills.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import {
  inspectBundleMcpRuntimeSupport,
  inspectNativePluginMcpRuntimeSupport,
} from "./bundle-mcp.js";
import { inspectBundlePluginArtifact } from "./install-artifact-inspection.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].toSorted();
}

export function emptyInstalledPluginComponents(): PluginInstalledComponents {
  return {
    mapped: [],
    skills: [],
    mcpServers: [],
    commands: [],
    hooks: [],
    lspServers: [],
    unavailable: { capabilities: [], mcpServers: [], lspServers: [] },
  };
}

/** Projects only components that the installed OpenClaw runtime can actually use. */
export function projectInstalledPluginComponents(params: {
  manifest?: PluginManifestRecord;
  declared: PluginDeclaredSurface;
}): PluginInstalledComponents {
  const { manifest, declared } = params;
  const skillNames = manifest?.rootDir
    ? resolvePluginSkillNames(manifest)
    : sorted(declared.skills);
  if (manifest?.format !== "bundle" || !manifest.bundleFormat) {
    const mcp = manifest?.rootDir
      ? inspectNativePluginMcpRuntimeSupport({
          rootDir: manifest.rootDir,
          mcpServers: manifest.mcpServers ?? {},
        })
      : undefined;
    const skills = skillNames;
    const mcpServers = sorted(mcp?.supportedServerNames ?? declared.mcpServers);
    const commands = sorted(declared.cliCommands);
    const hooks = sorted(declared.hooks);
    return {
      mapped: [
        ...(skills.length > 0 ? ["skills"] : []),
        ...(mcpServers.length > 0 ? ["mcpServers"] : []),
        ...(commands.length > 0 ? ["commands"] : []),
        ...(hooks.length > 0 ? ["hooks"] : []),
      ],
      skills,
      mcpServers,
      commands,
      hooks,
      lspServers: [],
      unavailable: {
        capabilities: [],
        mcpServers: sorted(mcp?.unsupportedServerNames ?? []),
        lspServers: [],
      },
    };
  }

  const support = inspectBundlePluginArtifact({
    format: manifest.bundleFormat,
    capabilities: manifest.bundleCapabilities ?? [],
  });
  const mapped = new Set(support.mapped);
  const hooks =
    mapped.has("hooks") && manifest.rootDir
      ? sorted(
          (manifest.hooks ?? []).filter((dir) =>
            loadHookEntriesFromDir({
              dir: path.resolve(manifest.rootDir, dir),
              rootDir: manifest.rootDir,
              pluginId: manifest.id,
              source: "openclaw-plugin",
            }).some(({ hook }) => Boolean(hook.handlerPath)),
          ),
        )
      : [];
  if (mapped.has("hooks") && hooks.length === 0) {
    mapped.delete("hooks");
    support.unavailable.push("hooks");
  }
  const mcp = manifest.rootDir
    ? inspectBundleMcpRuntimeSupport({
        pluginId: manifest.id,
        rootDir: manifest.rootDir,
        bundleFormat: manifest.bundleFormat,
      })
    : undefined;
  const lsp = manifest.rootDir
    ? inspectBundleLspRuntimeSupport({
        pluginId: manifest.id,
        rootDir: manifest.rootDir,
        bundleFormat: manifest.bundleFormat,
      })
    : undefined;
  return {
    mapped: sorted(mapped),
    skills: mapped.has("skills") ? skillNames : [],
    mcpServers: mapped.has("mcpServers") ? sorted(mcp?.supportedServerNames ?? []) : [],
    commands: [],
    hooks,
    lspServers: mapped.has("lspServers") ? sorted(lsp?.supportedServerNames ?? []) : [],
    unavailable: {
      capabilities: sorted(support.unavailable),
      mcpServers: sorted(mcp?.unsupportedServerNames ?? []),
      lspServers: sorted(lsp?.unsupportedServerNames ?? []),
    },
  };
}
