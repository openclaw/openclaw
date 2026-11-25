import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

// Lineage is process state. A source host can load this module twice (its own graph and
// a dist plugin's natively aliased SDK); both copies must see one binding.
const inherited = resolveGlobalSingleton(
  Symbol.for("openclaw.inheritedProcessLineage"),
  (): { fds?: readonly number[]; nativeProcessOwner?: string } => ({}),
);

export function getInheritedNativeProcessOwner(): string | undefined {
  return inherited.nativeProcessOwner;
}

export function bindInheritedNativeProcessOwner(entrypoint: string): () => void {
  inherited.nativeProcessOwner = entrypoint;
  return () => {
    if (inherited.nativeProcessOwner === entrypoint) {
      inherited.nativeProcessOwner = undefined;
    }
  };
}

export function getInheritedProcessLineageFds(): readonly number[] {
  return inherited.fds ?? [];
}

export function bindInheritedProcessLineageFds(fds: readonly number[]): () => void {
  inherited.fds = fds;
  return () => {
    if (inherited.fds === fds) {
      inherited.fds = undefined;
    }
  };
}
