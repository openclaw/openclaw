import fs from "node:fs";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { isPathInside } from "../infra/path-guards.js";
import type { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import type { PluginRecoverySource } from "./plugin-generation-source-lookup.js";
import type { createPluginNativeAdmission } from "./plugin-native-admission.js";
import type { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";
import {
  copyPluginSourceFile,
  pluginSourceIdentityChangedOnlyByCtime,
} from "./plugin-source-file.js";
import {
  readPluginSourceDirectory,
  pluginSourceInputIdentity,
  type PluginCapturedSourceFact,
} from "./plugin-source-verification.js";

type PluginSourceCopyFile = NonNullable<Parameters<typeof copyPluginSourceFile>[3]>["copyFile"];
type PluginSourceCopyBatch = {
  copyFile?: PluginSourceCopyFile;
  [Symbol.dispose](): void;
};

function createPluginSourceCopyBatch(): PluginSourceCopyBatch {
  const createBatch = (
    fsSafeAdvanced as {
      createRootFileCopyBatchSync?: () => PluginSourceCopyBatch;
    }
  ).createRootFileCopyBatchSync;
  return createBatch ? createBatch() : { [Symbol.dispose]() {} };
}

export function createPluginSourceLinkCapture() {
  const links = new Set<string>();
  return {
    defer(filename: string, root: string, source = filename): boolean {
      if (
        !fs.lstatSync(filename).isSymbolicLink() ||
        isPathInside(root, fs.realpathSync(filename))
      ) {
        return false;
      }
      links.add(source);
      return true;
    },
    contains: (filename: string) => [...links].some((link) => isPathInside(link, filename)),
  };
}

/** Capture each selected package file once, retaining its source facts and ordered receipt. */
export function createPluginGenerationFileCapture({
  boundary,
  destination,
  directory,
  outputRoot,
  capturedPaths,
  originalSources,
  hardlinkedSources,
  sourceCapture,
  sourceLinks,
  deferExternalLinks,
  nativeAdmission,
  receipt,
  retained,
  sourceFacts,
  onPackageMetadata,
}: {
  boundary: string;
  destination: string;
  directory: string;
  outputRoot?: string;
  capturedPaths: Map<string, string>;
  originalSources: Map<string, string>;
  hardlinkedSources: Set<string>;
  sourceCapture: Pick<
    ReturnType<typeof createPluginSourceCapture>,
    "inputs" | "pendingInputs" | "additions"
  >;
  sourceLinks: ReturnType<typeof createPluginSourceLinkCapture>;
  deferExternalLinks: boolean;
  nativeAdmission: ReturnType<typeof createPluginNativeAdmission>;
  receipt: ReturnType<typeof createPluginGenerationReceipt>;
  retained?: {
    source: PluginRecoverySource;
    files: ReadonlyMap<string, PluginCapturedSourceFact>;
  };
  sourceFacts?: Map<string, PluginCapturedSourceFact>;
  onPackageMetadata: (source: string, target: string) => void;
}) {
  const { inputs, pendingInputs, additions } = sourceCapture;
  const ancestors = new Set<string>();
  const copy = (source: string, target: string, copyFile: PluginSourceCopyFile | undefined) => {
    // Metadata can precede its package body; promotion never replaces those captured bytes.
    if (capturedPaths.get(path.resolve(source)) === target) {
      return;
    }
    const prepared = nativeAdmission.resolvePreparedSource(source);
    const input = prepared?.path ?? source;
    const inputBoundary = prepared?.boundary ?? boundary;
    const real = fs.realpathSync(input);
    const retainedNative = nativeAdmission.isRetainedReference(source, real);
    if (!isPathInside(inputBoundary, real) && !retainedNative) {
      throw new Error(
        `Plugin source link leaves its package: ${path.relative(boundary, source)}. Declare shared code as a package dependency.`,
      );
    }
    if (!prepared && outputRoot && isPathInside(outputRoot, real)) {
      return;
    }
    const stat = fs.statSync(real, { bigint: true });
    const captured = capturedPaths.get(real);
    const recordContent = (
      contentHash: string,
      sizeBytes = 0,
      native = false,
      identity = pluginSourceInputIdentity(stat),
      admittedBoundary = inputBoundary,
    ) => {
      if (sourceFacts) {
        const original = fs.realpathSync(source);
        sourceFacts.set(path.relative(directory, target), {
          source: path.resolve(source),
          input: {
            identity: pluginSourceInputIdentity(fs.statSync(original, { bigint: true })),
            contentHash: stat.isDirectory()
              ? readPluginSourceDirectory(original).contentHash
              : contentHash,
            sizeBytes,
            directory: stat.isDirectory(),
            boundary: isPathInside(boundary, original) ? boundary : path.dirname(original),
          },
        });
      }
      if (!captured) {
        // Filesystem ticks can hide edits; aliases retain their first captured content facts.
        inputs.set(real, {
          identity,
          contentHash,
          sizeBytes,
          directory: stat.isDirectory(),
          boundary: admittedBoundary,
          ...(native ? { native: true } : {}),
        });
        pendingInputs.add(real);
      }
    };
    capturedPaths.set(path.resolve(source), target);
    originalSources.set(target, path.resolve(source));
    // SDK companion loaders receive copied paths; those exact aliases retain this owner.
    capturedPaths.set(target, target);
    if (!capturedPaths.has(real)) {
      capturedPaths.set(real, target);
    }
    // Receipts cover copied empty directories as well as file contents.
    receipt.marker(
      `${stat.isDirectory() ? "directory" : "file"}\0${path.relative(destination, target)}\0`,
    );
    if (stat.isDirectory()) {
      if (ancestors.has(real)) {
        throw new Error(`Plugin source contains a directory cycle: ${source}`);
      }
      ancestors.add(real);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const { names, contentHash } = readPluginSourceDirectory(real);
      recordContent(contentHash);
      for (const name of names) {
        if (
          !(
            deferExternalLinks &&
            !nativeAdmission.isRetainedReference(path.join(source, name)) &&
            sourceLinks.defer(path.join(input, name), inputBoundary, path.join(source, name))
          )
        ) {
          copy(path.join(source, name), path.join(target, name), copyFile);
        }
      }
      ancestors.delete(real);
    } else if (stat.isFile()) {
      if (stat.nlink > 1n) {
        hardlinkedSources.add(target);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      // Register before copying or admission can fail: known aliases must remain
      // rejected by the acquisition owner even when the first attempt is incomplete.
      additions.add(target);
      const retainedFile = retained?.files.get(path.relative(directory, target));
      if (retainedFile && retainedFile.source !== path.resolve(source)) {
        throw new Error("Plugin retained source layout changed during admission");
      }
      const retainedReference = retained?.source.native?.references.has(target);
      if (retainedReference) {
        // The fork owns this validated reference; the new lease must admit its own native owner.
        fs.unlinkSync(target);
      }
      const native = nativeAdmission.materialize(real, inputBoundary, target, stat, source);
      let copiedContent: ReturnType<typeof copyPluginSourceFile>;
      if (native) {
        nativeAdmission.reconcileSourceInputs(inputs);
      } else if (retainedFile && !retainedReference) {
        const retainedInput = retainedFile.input;
        // The receipt verifies the private copy against these retained content facts.
        copiedContent = {
          contentHash: retainedInput.contentHash,
          sizeBytes: retainedInput.sizeBytes,
          sourceIdentity: pluginSourceInputIdentity(stat),
        };
      } else if (captured) {
        // A second filename for a prefetched entry retains its first bytes and source identity.
        copiedContent = copyPluginSourceFile(captured, directory, target, {
          hashCopiedContent: true,
          copyFile,
          preserveSourceMode: true,
        });
      } else {
        copiedContent = copyPluginSourceFile(real, inputBoundary, target, {
          hashCopiedContent: true,
          copyFile,
        });
        const identity = pluginSourceInputIdentity(stat);
        if (
          copiedContent &&
          copiedContent.sourceIdentity !== identity &&
          !pluginSourceIdentityChangedOnlyByCtime(identity, copiedContent.sourceIdentity)
        ) {
          throw new Error(
            "Plugin source changed while preparing its reload; retry after the edit finishes.",
          );
        }
      }
      receipt.file({
        target: native?.path ?? target,
        boundary: native?.boundary ?? directory,
        sizeBytes: Number(stat.size),
        native: native !== undefined,
        prepared: native?.content ?? copiedContent,
        onContent: (content) => {
          native?.record(content);
          recordContent(
            content.contentHash,
            content.sizeBytes,
            native !== undefined,
            native?.sourceIdentity ?? (captured ? undefined : copiedContent?.sourceIdentity),
            native?.sourceBoundary ?? inputBoundary,
          );
        },
      });
      if (path.basename(target) === "package.json") {
        onPackageMetadata(source, target);
      }
    } else {
      throw new Error(`Plugin build input is not a regular file: ${source}`);
    }
  };
  return (source: string, target: string) => {
    using batch = createPluginSourceCopyBatch();
    return copy(source, target, batch.copyFile?.bind(batch));
  };
}
