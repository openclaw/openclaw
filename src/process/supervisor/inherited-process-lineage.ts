let currentFds: readonly number[] | undefined;

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
