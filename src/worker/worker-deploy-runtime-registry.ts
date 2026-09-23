let loadHighlightJs: (() => unknown) | undefined;

export function setWorkerDeployHighlightJsLoader(next: () => unknown): void {
  loadHighlightJs = next;
}

export function getWorkerDeployHighlightJs(): unknown {
  return loadHighlightJs?.();
}
