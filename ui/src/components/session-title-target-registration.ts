// Producers can mount before the app's lazy hovercard bootstrap has loaded.
const { promise: registrar, resolve: installSessionTitleRegistrar } =
  Promise.withResolvers<(target: HTMLElement, label: HTMLElement) => () => void>();

export { installSessionTitleRegistrar };

export function registerSessionTitleTarget(target: HTMLElement, label: HTMLElement): () => void {
  let active = true;
  let release: (() => void) | undefined;
  void registrar.then((register) => {
    if (active) {
      release = register(target, label);
    }
  });
  return () => {
    active = false;
    release?.();
  };
}
