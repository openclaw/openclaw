import path from "node:path";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type {
  PluginDeclaredSurface,
  PluginInstalledComponents,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { loadHookEntriesFromDir } from "../hooks/discovery.js";
import { resolvePluginSkillDetails } from "../skills/loading/plugin-skills.js";
import { inspectBundleLspRuntimeSupport } from "./bundle-lsp.js";
import {
  inspectBundleMcpRuntimeSupport,
  inspectNativePluginMcpRuntimeSupport,
} from "./bundle-mcp.js";
import { inspectBundlePluginArtifact } from "./install-artifact-inspection.js";
import type { PluginManifestRecord } from "./manifest-registry.js";

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
  const skillDetails = manifest?.rootDir ? resolvePluginSkillDetails(manifest) : undefined;
  const skillNames = skillDetails?.map((skill) => skill.name) ?? sortUniqueStrings(declared.skills);
  if (manifest?.format !== "bundle" || !manifest.bundleFormat) {
    const mcp = manifest?.rootDir
      ? inspectNativePluginMcpRuntimeSupport({
          rootDir: manifest.rootDir,
          mcpServers: manifest.mcpServers ?? {},
        })
      : undefined;
    const skills = skillNames;
    const mcpServers = sortUniqueStrings(mcp?.supportedServerNames ?? declared.mcpServers);
    const commands = sortUniqueStrings(declared.cliCommands);
    const hooks = sortUniqueStrings(declared.hooks);
    return {
      mapped: [
        ...(skills.length > 0 ? ["skills"] : []),
        ...(mcpServers.length > 0 ? ["mcpServers"] : []),
        ...(commands.length > 0 ? ["commands"] : []),
        ...(hooks.length > 0 ? ["hooks"] : []),
      ],
      skills,
      ...(skillDetails ? { skillDetails } : {}),
      mcpServers,
      commands,
      hooks,
      lspServers: [],
      unavailable: {
        capabilities: [],
        mcpServers: sortUniqueStrings(mcp?.unsupportedServerNames ?? []),
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
      ? sortUniqueStrings(
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
    mapped: sortUniqueStrings(mapped),
    skills: mapped.has("skills") ? skillNames : [],
    ...(mapped.has("skills") && skillDetails ? { skillDetails } : {}),
    mcpServers: mapped.has("mcpServers") ? sortUniqueStrings(mcp?.supportedServerNames ?? []) : [],
    commands: [],
    hooks,
    lspServers: mapped.has("lspServers") ? sortUniqueStrings(lsp?.supportedServerNames ?? []) : [],
    unavailable: {
      capabilities: sortUniqueStrings(support.unavailable),
      mcpServers: sortUniqueStrings(mcp?.unsupportedServerNames ?? []),
      lspServers: sortUniqueStrings(lsp?.unsupportedServerNames ?? []),
    },
  };
}
