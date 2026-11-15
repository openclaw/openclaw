import { action, createOptimistic } from "solid-js";

/** The caller admits decisions; closing its surface only retires this presentation. */
export function createApprovalDecisionPresentation() {
  const [deciding, setDeciding] = createOptimistic(false);
  let lifetime = Promise.withResolvers<void>();
  const present = action(function* (completion: Promise<void>) {
    setDeciding(true);
    yield completion;
  });
  return {
    deciding,
    async run(pending: void | Promise<void>) {
      const completion = Promise.race([pending, lifetime.promise]);
      // Publish the synchronous owner's admission before joining its presentation.
      await Promise.resolve();
      return present(completion);
    },
    retire: () => {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
  };
}
