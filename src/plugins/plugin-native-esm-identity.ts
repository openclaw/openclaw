import fs from "node:fs";
import path from "node:path";
import { isMainThread, workerData } from "node:worker_threads";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import type { PluginModuleLoaderOwner } from "./plugin-instance.types.js";
import type { buildPluginTypeScriptSource, PluginSourceFile } from "./plugin-source-build.js";

type RetainedNativeEsmCapture = {
  artifact?: ReturnType<typeof capturePluginGenerationArtifact>;
  loaded: boolean;
  owners: Map<object, PluginModuleLoaderOwner>;
  knownOwners: WeakSet<object>;
  sourceBuilds: Map<string, ReturnType<typeof buildPluginTypeScriptSource>>;
  owner(): PluginModuleLoaderOwner;
  execute: <T>(run: () => T) => T;
  sourceForOutput(filename: string): PluginSourceFile;
  moduleSource: (filename: string) => string;
  load(source: string, load: (source: string) => unknown): unknown;
  discard(): void;
};

const captures = resolveGlobalMap<string, RetainedNativeEsmCapture>(
  Symbol.for("openclaw.retainedNativeEsmPluginCaptures"),
  "plugin-registry",
);

/** One workspace's native graph, captured files, and compiler output share a worker lifetime. */
export function getRetainedNativeEsmCapture(
  source: string,
  workspaceDir?: string,
): RetainedNativeEsmCapture | undefined {
  if (
    isMainThread ||
    workerData === null ||
    typeof workerData !== "object" ||
    !("sourceCaptureDirectory" in workerData)
  ) {
    return undefined;
  }
  const extension = path.extname(source).toLowerCase();
  if (extension !== ".mjs" && (extension !== ".js" || !nearestPackageTypeIsModule(source))) {
    return undefined;
  }
  let entry: string;
  try {
    entry = fs.realpathSync(source);
  } catch {
    return undefined;
  }
  const key = `${entry}\0${workspaceDir?.trim() ?? ""}`;
  let capture = captures.get(key);
  if (!capture) {
    capture = createRetainedCapture(entry);
    captures.set(key, capture);
  }
  return capture;
}

function createRetainedCapture(entry: string): RetainedNativeEsmCapture {
  const owners = new Map<object, PluginModuleLoaderOwner>();
  const knownOwners = new WeakSet<object>();
  const modules = new Map<string, unknown>();
  const sourceBuilds = new Map<string, ReturnType<typeof buildPluginTypeScriptSource>>();
  const capture: RetainedNativeEsmCapture = {
    loaded: false,
    owners,
    knownOwners,
    sourceBuilds,
    owner(): PluginModuleLoaderOwner {
      const requested = pluginInstanceInvocation.getStore()?.instance;
      const owner = requested
        ? owners.get(requested)
        : owners.size === 1
          ? owners.values().next().value
          : undefined;
      if (!owner) {
        throw new Error("Plugin native ESM capture has no live workspace owner for this load");
      }
      return owner;
    },
    execute: <T>(run: () => T): T => capture.owner().run(run),
    sourceForOutput(filename: string): PluginSourceFile {
      for (const build of sourceBuilds.values()) {
        const source = build.sourceForOutput(filename);
        if (source) {
          return source;
        }
      }
      return { source: filename };
    },
    moduleSource: (filename: string): string => {
      const source = capture.sourceForOutput(filename);
      return source.generated ? filename : source.source;
    },
    load(source: string, load: (source: string) => unknown): unknown {
      let key: string;
      try {
        key = fs.realpathSync(source);
      } catch {
        key = path.resolve(source);
      }
      if (modules.has(key)) {
        return modules.get(key);
      }
      const value = load(source);
      modules.set(key, value);
      if (key === entry) {
        capture.loaded = true;
      }
      return value;
    },
    discard(): void {
      capture.artifact = undefined;
      modules.clear();
    },
  };
  return capture;
}

function nearestPackageTypeIsModule(source: string): boolean {
  let directory = path.dirname(source);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        return (
          typeof parsed === "object" &&
          parsed !== null &&
          Object.getOwnPropertyDescriptor(parsed, "type")?.value === "module"
        );
      } catch {
        return false;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}
