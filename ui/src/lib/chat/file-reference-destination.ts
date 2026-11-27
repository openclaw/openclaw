import type { ComposerFileReference } from "./file-references.ts";

export type FileReferenceDestinationSnapshot = {
  text: string;
  revision: number;
  targetId: string;
  references: readonly ComposerFileReference[];
};
export type FileReferenceDestinationReceipt = {
  status: "committed" | "not-committed" | "outcome-unknown";
};
export type FileReferenceDestination = {
  schemaVersion: 1;
  namespace: "openclaw.session-file.v1";
  snapshot(): FileReferenceDestinationSnapshot;
  commit(input: {
    id: string;
    snapshot: FileReferenceDestinationSnapshot;
    from: number;
    to: number;
    text: string;
    references: readonly ComposerFileReference[];
  }): FileReferenceDestinationReceipt;
  clearReferences(): void;
};

const destinations = new WeakMap<HTMLTextAreaElement, FileReferenceDestination>();
const preparers = new WeakMap<HTMLTextAreaElement, () => Promise<void>>();

export function registerFileReferenceDestination(
  input: HTMLTextAreaElement,
  destination: FileReferenceDestination,
) {
  destinations.set(input, destination);
  return () => {
    if (destinations.get(input) === destination) {
      destinations.delete(input);
    }
  };
}

export function registerFileReferenceDestinationPreparation(
  input: HTMLTextAreaElement,
  prepare: () => Promise<void>,
) {
  preparers.set(input, prepare);
  return () => {
    if (preparers.get(input) === prepare) {
      preparers.delete(input);
    }
  };
}

export function readFileReferenceDestination(input: HTMLTextAreaElement) {
  return destinations.get(input) ?? null;
}

/** Only a mounted, identity-capable editor can claim this namespace. */
export async function prepareFileReferenceDestination(input: HTMLTextAreaElement) {
  if (!destinations.has(input)) {
    await preparers.get(input)?.();
  }
  return readFileReferenceDestination(input);
}
