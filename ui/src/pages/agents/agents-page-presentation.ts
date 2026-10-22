import { action, createOptimistic, onSettled } from "solid-js";

export function createAgentsPagePresentation(retired: () => Promise<void>) {
  const [identitySaving, setIdentitySaving] = createOptimistic(false);
  const presentIdentitySave = action(function* (
    completion: Promise<void>,
    retirement: Promise<void>,
  ) {
    if (retirement === retired()) {
      setIdentitySaving(true);
    }
    yield Promise.race([completion, retirement]);
  });
  return {
    identitySaving,
    saveIdentity(completion: Promise<void>) {
      // Scope changes release presentation; the owner still settles its admitted write.
      const retirement = retired();
      onSettled(() => {
        void presentIdentitySave(completion, retirement);
      });
    },
  };
}
