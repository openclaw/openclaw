let currentFds: readonly number[] | undefined;
let nativeProcessOwner: string | undefined;

export function getInheritedNativeProcessOwner(): string | undefined {
  return nativeProcessOwner;
}

export function bindInheritedNativeProcessOwner(entrypoint: string): () => void {
  nativeProcessOwner = entrypoint;
  return () => {
    if (nativeProcessOwner === entrypoint) {
      nativeProcessOwner = undefined;
    }
  };
}

export function getInheritedProcessLineageFds(): readonly number[] {
  return currentFds ?? [];
}

export function bindInheritedProcessLineageFds(fds: readonly number[]): () => void {
  currentFds = fds;
  return () => {
    if (currentFds === fds) {
      currentFds = undefined;
    }
  };
}
