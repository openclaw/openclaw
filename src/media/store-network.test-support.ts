import { AsyncLocalStorage } from "node:async_hooks";

type SaveRemoteMedia = typeof import("./fetch.js").saveRemoteMedia;
type RemoteMediaOptions = Parameters<SaveRemoteMedia>[0];

type StoreRemoteFixtureOptions = {
  url: string;
  lookupFn?: RemoteMediaOptions["lookupFn"];
  onMatch?: (url: string) => void;
};

type StoreRemoteFixtureScope = StoreRemoteFixtureOptions & { active: boolean };
const storeRemoteFixture = new AsyncLocalStorage<StoreRemoteFixtureScope>();
let activeScopes = 0;

/** Scope the admitted call chain; callbacks with an outside async owner remain unscoped. */
export async function withStoreRemoteFixture<T>(
  options: StoreRemoteFixtureOptions,
  run: () => Promise<T>,
): Promise<T> {
  const scope = { ...options, active: true };
  activeScopes += 1;
  try {
    return await storeRemoteFixture.run(scope, run);
  } finally {
    // Detached descendants can retain the ALS object after run settles, but not its routing grant.
    scope.active = false;
    activeScopes -= 1;
  }
}

/** Release the test module's async context owner after every fixture operation has joined. */
export function disposeStoreRemoteFixtures(): void {
  if (activeScopes !== 0) {
    throw new Error("Store remote fixtures are still active");
  }
  storeRemoteFixture.disable();
}

/** Preserve the real fetch/store pipeline while routing only the exact scoped fixture URL. */
export function wrapStoreSaveRemoteMedia(save: SaveRemoteMedia): SaveRemoteMedia {
  return (options) => {
    const scope = storeRemoteFixture.getStore();
    if (!scope?.active || options.url !== scope.url) {
      return save(options);
    }
    if (options.lookupFn !== undefined || options.ssrfPolicy !== undefined) {
      throw new Error("Store fixture unexpectedly received an existing routing policy");
    }
    scope.onMatch?.(options.url);
    return save({
      ...options,
      ...(scope.lookupFn ? { lookupFn: scope.lookupFn } : {}),
      // The exact URL match above admits this call; redirects retain the real guard's origin rules.
      ssrfPolicy: { allowedOrigins: [new URL(scope.url).origin] },
    });
  };
}
