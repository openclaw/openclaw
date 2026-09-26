import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  pluginNativeNamespaceBoundary,
  pluginNativeNamespaceMemberPath,
  pluginNativeNamespaceMemberRelativePath,
} from "./plugin-native-namespace.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
} from "./plugin-source-admission.types.js";
import {
  hashPluginSourceFile,
  linkPluginSourceFile,
  pluginSourceIdentityChangedOnlyByCtime,
  pluginSourceStatIdentity,
} from "./plugin-source-file.js";

/** A hardlink needs the owner's complete-directory check before the generation is exposed. */
export function linkPluginNativeReference(
  source: string,
  target: string,
  fact: PluginNativeArtifactFact,
): "symlink" | "hardlink" {
  try {
    fs.symlinkSync(fact.capturedPath, target, "file");
    return "symlink";
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].some((code) => hasErrnoCode(error, code))) {
      throw error;
    }
  }
  const boundary = path.dirname(fact.capturedPath);
  linkPluginSourceFile(fact.capturedPath, boundary, target);
  if (fact.contentHash) {
    const content = hashPluginSourceFile(fact.capturedPath, boundary);
    if (content.contentHash !== fact.contentHash || content.sizeBytes !== fact.sizeBytes) {
      throw new Error("Native plugin artifact changed while linking its generation");
    }
  }
  const captured = fs.statSync(fact.capturedPath, { bigint: true });
  const sourceStat = fs.statSync(source, { bigint: true });
  const identity = pluginSourceStatIdentity(sourceStat);
  if (
    identity !== fact.sourceIdentity &&
    (!pluginSourceIdentityChangedOnlyByCtime(fact.sourceIdentity, identity) ||
      ((captured.dev !== sourceStat.dev || captured.ino !== sourceStat.ino) &&
        (!fact.contentHash ||
          hashPluginSourceFile(source, path.dirname(source)).contentHash !== fact.contentHash)))
  ) {
    throw new Error("Plugin source changed while linking its native artifact");
  }
  fact.sourceIdentity = identity;
  fact.capturedIdentity = pluginSourceStatIdentity(captured);
  return "hardlink";
}

function resolveNativeHost(filename: string): string | undefined {
  for (const modules of createRequire(filename).resolve.paths("openclaw") ?? []) {
    const candidate = path.join(modules, "openclaw");
    if (fs.existsSync(candidate)) {
      return fs.realpathSync(candidate);
    }
  }
  return undefined;
}

/** Hardlinks keep bytes but not realpath parents; only a coherent captured directory can use them. */
export function assertPluginNativeReferenceNamespace(
  target: string,
  fact: PluginNativeArtifactFact,
  namespace: PluginNativeNamespaceFact,
  boundary: string,
  expectedHost?: string,
): void {
  const relative = pluginNativeNamespaceMemberRelativePath(namespace, fact.capturedPath);
  const directory = path.dirname(relative);
  try {
    for (const [name, member] of Object.entries(namespace.members)) {
      if (!isPathInside(directory, name || ".")) {
        continue;
      }
      const filename = fs.realpathSync(
        path.join(path.dirname(target), path.relative(directory, name || ".")),
      );
      if (
        !isPathInside(boundary, filename) &&
        !isPathInside(pluginNativeNamespaceBoundary(namespace), filename)
      ) {
        throw new Error(`Companion ${name} leaves the captured generation`);
      }
      const current = fs.statSync(filename, { bigint: true });
      if (member.sizeBytes === undefined) {
        if (!current.isDirectory()) {
          throw new Error(`Companion ${name} is not a directory`);
        }
        continue;
      }
      const captured = fs.statSync(pluginNativeNamespaceMemberPath(namespace, name), {
        bigint: true,
      });
      if (current.dev === captured.dev && current.ino === captured.ino) {
        continue;
      }
      const content = hashPluginSourceFile(filename, path.dirname(filename));
      if (content.contentHash !== member.contentHash || content.sizeBytes !== member.sizeBytes) {
        throw new Error(`Companion ${name} differs from its captured bytes`);
      }
    }
    if (expectedHost && resolveNativeHost(target) !== expectedHost) {
      throw new Error("The native companion directory resolves a different OpenClaw host");
    }
  } catch (cause) {
    throw new Error(
      "Native plugin companions cannot be preserved without file symlinks. Enable file symlink support for this filesystem, then reload the plugin.",
      { cause },
    );
  }
}

/** The caller has selected this exact recovery-map entry; symlinks and hardlinks retain its inode. */
export function admitPluginNativeRecoveryReference(
  canonical: string,
  fact: PluginNativeArtifactFact,
  prepared = fact,
): PluginNativeArtifactFact | undefined {
  if (fs.realpathSync(fact.capturedPath) !== fact.capturedPath) {
    return undefined;
  }
  const captured = fs.statSync(fact.capturedPath, { bigint: true });
  const source =
    canonical === fact.capturedPath ? captured : fs.statSync(canonical, { bigint: true });
  if (source.dev !== captured.dev || source.ino !== captured.ino) {
    return undefined;
  }
  const identity = pluginSourceStatIdentity(source);
  if (
    identity !== prepared.capturedIdentity ||
    prepared.contentHash !== fact.contentHash ||
    prepared.sizeBytes !== fact.sizeBytes
  ) {
    const content = hashPluginSourceFile(fact.capturedPath, path.dirname(fact.capturedPath));
    if (content.contentHash !== fact.contentHash || content.sizeBytes !== fact.sizeBytes) {
      return undefined;
    }
  }
  return { ...fact, sourceIdentity: identity, capturedIdentity: identity };
}
