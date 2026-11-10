import { createHash } from "node:crypto";
import type {
  WorkerWorkspaceReconciliationJournal,
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
  WorkerWorkspaceReconciliationJournalAdapter,
} from "./workspace-manifest.js";

export const sha256 = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

export function workspaceFile(
  path: string,
  content: string | Buffer,
): Extract<WorkerWorkspaceManifestEntry, { type: "file" }> {
  return {
    path,
    type: "file",
    mode: 0o644,
    size: Buffer.byteLength(content),
    sha256: sha256(content),
  };
}

export function workspaceManifest(
  contents: Record<string, string>,
  baseCommit: string | null = null,
): WorkerWorkspaceManifest {
  return {
    version: 1,
    baseCommit,
    entries: Object.entries(contents).map(([path, content]) => workspaceFile(path, content)),
  };
}

export const emptyJournal = (
  overrides: Partial<WorkerWorkspaceReconciliationJournalAdapter> = {},
): WorkerWorkspaceReconciliationJournalAdapter => ({
  load: async () => undefined,
  begin: async () => {},
  commit: async () => {},
  abort: async () => {},
  ...overrides,
});

export function workspaceJournal(
  baseManifestRef: string,
  currentManifestRef: string,
  overrides: Partial<
    Pick<
      WorkerWorkspaceReconciliationJournal,
      "temporaryNonce" | "baseEntries" | "appliedEntries" | "baseTree" | "basePack"
    >
  > = {},
): WorkerWorkspaceReconciliationJournal {
  const basePack = overrides.basePack ?? Buffer.alloc(0);
  return {
    version: 1,
    temporaryNonce: "a".repeat(32),
    baseManifestRef,
    currentManifestRef,
    baseEntries: [],
    appliedEntries: [],
    baseTree: "f".repeat(40),
    basePackSha256: createHash("sha256").update(basePack).digest("hex"),
    basePack,
    ...overrides,
  };
}
