import { createSignal } from "solid-js";

export type LazyRenderer<Renderer> = ReturnType<typeof createLazyRenderer<Renderer>>;

/** A shell-owned lazy view publishes only to its own rendering consumers. */
export function createLazyRenderer<Renderer>(importRenderer: () => Promise<Renderer>) {
  const [renderer, setRenderer] = createSignal<Renderer | null>(null);
  const [failed, setFailed] = createSignal(false);
  let pending: Promise<void> | null = null;

  const load = () => {
    pending ??= importRenderer()
      .then((value) => {
        setRenderer(() => value);
        setFailed(false);
      })
      .catch(() => {
        pending = null;
        setFailed(true);
      });
  };
  return {
    renderer,
    failed,
    load,
    retry() {
      setFailed(false);
      load();
    },
  };
}
