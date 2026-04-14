import type { Command } from "commander";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

export type QaRunnerCliRegistration = {
  commandName: string;
  register(qa: Command): void;
};

type QaRunnerRuntimeSurface = {
  listQaRunnerCliRegistrations?: () => readonly QaRunnerCliRegistration[];
  qaRunnerCliRegistrations?: readonly QaRunnerCliRegistration[];
};

export type QaRunnerCliContribution =
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "available";
      registration: QaRunnerCliRegistration;
    }
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "blocked";
    };

function listDeclaredQaRunnerPlugins(): Array<
  Pick<PluginManifestRecord, "id" | "qaRunners" | "rootDir">
> {
  return loadPluginManifestRegistry({ cache: true }).plugins
    .filter(
      (
        plugin,
      ): plugin is Pick<PluginManifestRecord, "id" | "qaRunners" | "rootDir"> & {
        qaRunners: NonNullable<PluginManifestRecord["qaRunners"]>;
      } => Array.isArray(plugin.qaRunners) && plugin.qaRunners.length > 0,
    )
    .toSorted((left, right) => {
      const idCompare = left.id.localeCompare(right.id);
      if (idCompare !== 0) {
        return idCompare;
      }
      return left.rootDir.localeCompare(right.rootDir);
    });
}

function listRuntimeRegistrations(
  pluginId: string,
  surface: QaRunnerRuntimeSurface,
): readonly QaRunnerCliRegistration[] {
  const registrations =
    surface.listQaRunnerCliRegistrations?.() ?? surface.qaRunnerCliRegistrations ?? [];
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (!registration?.commandName || typeof registration.register !== "function") {
      throw new Error(`QA runner plugin "${pluginId}" exported an invalid CLI registration`);
    }
    if (seen.has(registration.commandName)) {
      throw new Error(
        `QA runner plugin "${pluginId}" exported duplicate CLI registration "${registration.commandName}"`,
      );
    }
    seen.add(registration.commandName);
  }
  return registrations;
}

export function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[] {
  const contributions: QaRunnerCliContribution[] = [];
  const seenCommandNames = new Map<string, string>();

  for (const plugin of listDeclaredQaRunnerPlugins()) {
    const runtimeSurface = tryLoadActivatedBundledPluginPublicSurfaceModuleSync<QaRunnerRuntimeSurface>(
      {
        dirName: plugin.id,
        artifactBasename: "runtime-api.js",
      },
    );
    const runtimeRegistrations = runtimeSurface
      ? listRuntimeRegistrations(plugin.id, runtimeSurface)
      : null;

    for (const runner of plugin.qaRunners) {
      const previousOwner = seenCommandNames.get(runner.commandName);
      if (previousOwner) {
        throw new Error(
          `QA runner command "${runner.commandName}" declared by both "${previousOwner}" and "${plugin.id}"`,
        );
      }
      seenCommandNames.set(runner.commandName, plugin.id);

      const registration = runtimeRegistrations?.find(
        (entry) => entry.commandName === runner.commandName,
      );
      if (!runtimeSurface) {
        contributions.push({
          pluginId: plugin.id,
          commandName: runner.commandName,
          ...(runner.description ? { description: runner.description } : {}),
          status: "blocked",
        });
        continue;
      }
      if (!registration) {
        throw new Error(
          `QA runner plugin "${plugin.id}" declared "${runner.commandName}" in openclaw.plugin.json but did not export a matching CLI registration`,
        );
      }
      contributions.push({
        pluginId: plugin.id,
        commandName: runner.commandName,
        ...(runner.description ? { description: runner.description } : {}),
        status: "available",
        registration,
      });
    }
  }

  return contributions;
}
