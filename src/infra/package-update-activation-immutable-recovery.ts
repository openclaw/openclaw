import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { sha256Hex } from "./crypto-digest.js";
import { requireDirectorySync, syncDirectorySync } from "./directory-durability.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import {
  ImmutableRecoveryRuntimeReferenceSchema,
  type ImmutableRecoveryRuntimeReference,
} from "./package-update-activation-immutable-recovery-schema.js";
import {
  assertImmutableInstallRecordCurrent,
  captureImmutableControl,
} from "./package-update-activation-immutable.js";
import {
  packageActivationRuntimeIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
} from "./package-update-activation-paths.js";
import { isPathInside } from "./path-guards.js";
import { prepareSqliteRollbackRecovery } from "./sqlite-rollback-recovery.js";
import {
  sealImmutableGeneration,
  verifyImmutableGeneration,
} from "./update-immutable-generation.js";
import type {
  ImmutableInstallDescriptor,
  ImmutableInstallRecord,
} from "./update-immutable-install-schema.js";
import { directoryIdentity } from "./update-immutable-layout.js";

/** Cold CLI recovery stays outside the control record's read-worker dependency graph. */
export function readImmutableInstallRecordForRecovery(root: string) {
  const { control, journal, assertIdentity, assertFileSafe, validate, read } =
    captureImmutableControl(root);
  return prepareSqliteRollbackRecovery({
    path: journal,
    scratchRoot: control,
    assertIdentity,
    assertFileSafe,
    read(db) {
      validate(db);
      return read(db);
    },
  });
}

function controlRoot(root: string): string {
  return resolvePackageActivationControl(resolvePackageActivationAnchor(root));
}

function helperIdentity(file: string): string {
  const stat = fsSync.lstatSync(file, { bigint: true });
  if (
    !stat.isFile() ||
    stat.uid !== 0n ||
    stat.nlink !== 1n ||
    (stat.mode & 0o222n) !== 0n ||
    fsSync.realpathSync(file) !== file
  ) {
    throw new Error("Immutable recovery helper must be a sealed root-owned regular file.");
  }
  return `${stat.dev}:${stat.ino}`;
}

function helperSource(runtime: string, copy: string, root: string): string {
  // This launcher contains no recovery policy; the retained product owner admits
  // the independent journal and obtains fresh native authority on every run.
  return `import fs from "node:fs";
const runtime = ${JSON.stringify(runtime)};
const entry = ${JSON.stringify(path.join(copy, "openclaw.mjs"))};
const root = ${JSON.stringify(root)};
try {
  if (fs.realpathSync(process.execPath) !== runtime || typeof process.execve !== "function") {
    throw new Error("Use the recorded external Node executable for immutable recovery.");
  }
  const args = process.argv.slice(2);
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--json" && !seen.has(option)) { seen.add(option); continue; }
    if (["--timeout", "--drain-timeout"].includes(option) && !seen.has(option) && /^[0-9]+(?:\\.[0-9]+)?$/.test(args[index + 1] ?? "") && Number(args[index + 1]) > 0) {
      seen.add(option); index++; continue;
    }
    throw new Error("Usage: recovery.mjs [--json] [--timeout seconds] [--drain-timeout seconds]");
  }
  process.chdir(${JSON.stringify(copy)});
  process.execve(runtime, [runtime, entry, "update", "recover", "--root", root, ...args], process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;
}

/** Absolute in-tree links must move with the copy instead of borrowing the source. */
async function relocateAbsoluteLinks(
  source: string,
  copy: string,
  assertCurrent: () => void,
): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    assertCurrent();
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isSymbolicLink()) {
        const target = await fs.readlink(file);
        assertCurrent();
        if (path.isAbsolute(target)) {
          if (!isPathInside(source, target)) {
            throw new Error("Immutable recovery source has an external dependency link.");
          }
          const destination = path.join(copy, path.relative(source, target));
          fsSync.unlinkSync(file);
          fsSync.symlinkSync(path.relative(directory, destination), file);
        }
      }
    }
  };
  await visit(copy);
}

export async function prepareImmutableRecoveryRuntime(params: {
  record: ImmutableInstallRecord;
  assertCurrent: () => void;
}): Promise<ImmutableRecoveryRuntimeReference> {
  const { record, assertCurrent } = params;
  const descriptor = record.descriptor;
  if (!descriptor.activationEnabled || record.activation?.operation) {
    throw new Error(
      "Prepare immutable recovery only for enabled adoption without a pending operation.",
    );
  }
  const source = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
  assertCurrent();
  const generation = [descriptor.current, record.prepared].find((entry) => entry?.path === source);
  if (!source || !generation) {
    throw new Error("Run immutable activation from its sealed current or prepared generation.");
  }
  const sourceFacts = await verifyImmutableGeneration(source, generation.sha);
  assertCurrent();
  if (
    sourceFacts.identity !== generation.identity ||
    sourceFacts.buildDigest !== generation.buildDigest
  ) {
    throw new Error("The invoking sealed generation no longer matches its preparation receipt.");
  }
  const control = controlRoot(descriptor.root);
  const controlIdentity = directoryIdentity(control);
  const assertOwner = () => {
    assertImmutableInstallRecordCurrent(record, assertCurrent);
    if (
      fsSync.realpathSync(control) !== control ||
      directoryIdentity(control) !== controlIdentity ||
      packageActivationRuntimeIdentity(descriptor.runtime.path) !== descriptor.runtime.identity
    ) {
      throw new Error("Immutable recovery preparation ownership changed.");
    }
  };
  assertOwner();
  const destination = path.join(control, `recovery-${generation.sha}`);
  if (!fsSync.lstatSync(destination, { throwIfNoEntry: false })) {
    const scratch = await fs.mkdtemp(path.join(control, ".recovery-prepare-"));
    const scratchIdentity = directoryIdentity(scratch);
    const staged = path.join(scratch, "runtime");
    try {
      assertOwner();
      await fs.cp(source, staged, {
        recursive: true,
        verbatimSymlinks: true,
        force: false,
        errorOnExist: true,
      });
      assertOwner();
      const stagedIdentity = directoryIdentity(staged);
      await relocateAbsoluteLinks(source, staged, assertCurrent);
      assertOwner();
      await sealImmutableGeneration(staged);
      assertOwner();
      const prepared = await verifyImmutableGeneration(staged, generation.sha);
      assertOwner();
      if (prepared.identity !== stagedIdentity || prepared.buildDigest !== generation.buildDigest) {
        throw new Error(
          "Independent immutable recovery copy differs from the invoking generation.",
        );
      }
      if (fsSync.lstatSync(destination, { throwIfNoEntry: false })) {
        throw new Error("An immutable recovery runtime already exists; it was preserved.");
      }
      fsSync.renameSync(staged, destination);
      requireDirectorySync(syncDirectorySync(control), "Immutable recovery runtime publication");
    } finally {
      if (
        fsSync.lstatSync(scratch, { throwIfNoEntry: false }) &&
        directoryIdentity(scratch) === scratchIdentity
      ) {
        fsSync.rmSync(scratch, { recursive: true });
      }
    }
  }
  const facts = await verifyImmutableGeneration(destination, generation.sha);
  assertOwner();
  if (facts.buildDigest !== generation.buildDigest) {
    throw new Error("Existing immutable recovery runtime differs; it was preserved.");
  }
  const helperPath = resolvePackageActivationHelper(
    resolvePackageActivationAnchor(descriptor.root),
  );
  const content = helperSource(descriptor.runtime.path, destination, descriptor.root);
  const existing = fsSync.lstatSync(helperPath, { throwIfNoEntry: false });
  if (existing) {
    helperIdentity(helperPath);
  }
  if (!existing || fsSync.readFileSync(helperPath, "utf8") !== content) {
    const temporary = path.join(control, `.recovery-launcher-${randomUUID()}`);
    const fd = fsSync.openSync(temporary, "wx", 0o444);
    const staged = fsSync.fstatSync(fd);
    try {
      fsSync.writeFileSync(fd, content);
      fsSync.fchmodSync(fd, 0o444);
      fsSync.fsyncSync(fd);
      assertOwner();
      const current = fsSync.lstatSync(helperPath, { throwIfNoEntry: false });
      if (current?.dev !== existing?.dev || current?.ino !== existing?.ino) {
        throw new Error("Immutable recovery launcher changed before publication.");
      }
      fsSync.renameSync(temporary, helperPath);
      requireDirectorySync(syncDirectorySync(control), "Immutable recovery launcher publication");
    } finally {
      fsSync.closeSync(fd);
      const remaining = fsSync.lstatSync(temporary, { throwIfNoEntry: false });
      if (remaining?.dev === staged.dev && remaining?.ino === staged.ino) {
        fsSync.unlinkSync(temporary);
      }
    }
  }
  assertOwner();
  return ImmutableRecoveryRuntimeReferenceSchema.parse({
    root: descriptor.root,
    path: destination,
    sha: generation.sha,
    ...facts,
    helperPath,
    helperIdentity: helperIdentity(helperPath),
    helperDigest: sha256Hex(content),
  });
}

export async function verifyImmutableRecoveryRuntime(params: {
  reference: ImmutableRecoveryRuntimeReference;
  descriptor: ImmutableInstallDescriptor;
  assertCurrent: () => void;
}): Promise<void> {
  const { descriptor, assertCurrent } = params;
  const reference = ImmutableRecoveryRuntimeReferenceSchema.parse(params.reference);
  const control = controlRoot(descriptor.root);
  if (
    reference.root !== descriptor.root ||
    reference.path !== path.join(control, `recovery-${reference.sha}`) ||
    reference.helperPath !==
      resolvePackageActivationHelper(resolvePackageActivationAnchor(descriptor.root))
  ) {
    throw new Error("Immutable recovery artifact belongs to a different installation.");
  }
  const controlIdentity = directoryIdentity(control);
  const assertHelper = () => {
    assertCurrent();
    if (
      fsSync.realpathSync(control) !== control ||
      directoryIdentity(control) !== controlIdentity ||
      directoryIdentity(descriptor.root) !== descriptor.rootIdentity ||
      packageActivationRuntimeIdentity(descriptor.runtime.path) !== descriptor.runtime.identity ||
      helperIdentity(reference.helperPath) !== reference.helperIdentity ||
      sha256Hex(fsSync.readFileSync(reference.helperPath)) !== reference.helperDigest ||
      fsSync.readFileSync(reference.helperPath, "utf8") !==
        helperSource(descriptor.runtime.path, reference.path, descriptor.root)
    ) {
      throw new Error("Immutable recovery artifact identity or executable changed.");
    }
  };
  assertHelper();
  const facts = await verifyImmutableGeneration(reference.path, reference.sha);
  assertHelper();
  if (facts.identity !== reference.identity || facts.buildDigest !== reference.buildDigest) {
    throw new Error("Immutable recovery runtime no longer matches its recorded artifact.");
  }
}

export function resolveImmutableRecoveryCommand(
  reference: ImmutableRecoveryRuntimeReference,
  descriptor: ImmutableInstallDescriptor,
): string {
  return `${quoteCliArg(descriptor.runtime.path)} ${quoteCliArg(reference.helperPath)}`;
}
