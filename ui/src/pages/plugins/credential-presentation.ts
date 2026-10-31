import { onSettled } from "solid-js";
import type { ApplicationContext } from "../../app/context.ts";

/** Shared by plugin and Search settings; writes outlive their route presentation. */
export function createCredentialPresentation(router: ApplicationContext["router"]) {
  let lifetime = Promise.withResolvers<void>();
  function retire() {
    lifetime.resolve();
    lifetime = Promise.withResolvers<void>();
  }
  onSettled(() => {
    let route = router.getState().location;
    const stop = router.subscribe(({ location }) => {
      if (
        route.pathname !== location.pathname ||
        route.search !== location.search ||
        route.hash !== location.hash
      ) {
        route = location;
        retire();
      }
    });
    return () => {
      stop();
      retire();
    };
  });
  return {
    get lifetime() {
      return lifetime.promise;
    },
    retire,
  };
}
