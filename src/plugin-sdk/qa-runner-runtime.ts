import type { Command } from "commander";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { listBundledQaRunnerCatalog } from "../plugins/qa-runner-catalog.js";
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
    }
  | {
      pluginId: string;
      commandName: string;
      description?: string;
      status: "missing";
      npmSpec: string;
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

function buildKnownQaRunnerCatalog(): readonly QaRunnerCliContribution[] {
  const knownRunners = listBundledQaRunnerCatalog();
  const seenCommandNames = new Map<string, string>();
  return knownRunners.map((runner) => {
    const previousOwner = seenCommandNames.get(runner.commandName);
    if (previousOwner) {
      throw new Error(
        `QA runner command "${runner.commandName}" declared by both "${previousOwner}" and "${runner.pluginId}"`,
      );
    }
    seenCommandNames.set(runner.commandName, runner.pluginId);
    return {
      pluginId: runner.pluginId,
      commandName: runner.commandName,
      ...(runner.description ? { description: runner.description } : {}),
      status: "missing" as const,
      npmSpec: runner.npmSpec,
    };
  });
}

export function listQaRunnerCliContributions(): readonly QaRunnerCliContribution[] {
  const contributions = new Map<string, QaRunnerCliContribution>();

  for (const runner of buildKnownQaRunnerCatalog()) {
    contributions.set(runner.commandName, runner);
  }

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
    const declaredCommandNames = new Set(plugin.qaRunners.map((runner) => runner.commandName));

    for (const runner of plugin.qaRunners) {
      const previous = contributions.get(runner.commandName);
      if (previous && previous.pluginId !== plugin.id) {
        throw new Error(
          `QA runner command "${runner.commandName}" declared by both "${previous.pluginId}" and "${plugin.id}"`,
        );
      }

      const registration = runtimeRegistrations?.find(
        (entry) => entry.commandName === runner.commandName,
      );
      if (!runtimeSurface) {
        contributions.set(runner.commandName, {
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
      contributions.set(runner.commandName, {
        pluginId: plugin.id,
        commandName: runner.commandName,
        ...(runner.description ? { description: runner.description } : {}),
        status: "available",
        registration,
      });
    }

    for (const registration of runtimeRegistrations ?? []) {
      if (!declaredCommandNames.has(registration.commandName)) {
        throw new Error(
          `QA runner plugin "${plugin.id}" exported "${registration.commandName}" from runtime-api.js but did not declare it in openclaw.plugin.json`,
        );
      }
    }
  }

  return [...contributions.values()];
}
