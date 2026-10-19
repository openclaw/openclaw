type SessionTitleRegistrar = (target: HTMLElement, label: HTMLElement) => () => void;

// Producers can mount before the app's lazy hovercard bootstrap has loaded.
const registrar = Promise.withResolvers<SessionTitleRegistrar>();

export function installSessionTitleRegistrar(register: SessionTitleRegistrar): void {
  registrar.resolve(register);
}

export function registerSessionTitleTarget(target: HTMLElement, label: HTMLElement): () => void {
  let active = true;
  let release: (() => void) | undefined;
  void registrar.promise.then((register) => {
    if (active) {
      release = register(target, label);
    }
  });
  return () => {
    active = false;
    release?.();
  };
}
