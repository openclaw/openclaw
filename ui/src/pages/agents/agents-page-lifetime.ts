/** Shares the page owner's synchronous retirement boundary with pending presentations. */
export function createAgentsPageLifetime() {
  let lifetime = Promise.withResolvers<void>();
  return {
    retired: () => lifetime.promise,
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
  };
}
