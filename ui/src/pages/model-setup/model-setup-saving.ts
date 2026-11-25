import { action, createMemo, createOptimistic, onSettled } from "solid-js";
import type { ModelSetupConnection } from "./first-run-setup.ts";

export function createModelSetupSaving(getConnection: () => ModelSetupConnection | null) {
  const connection = createMemo(getConnection);
  const presentation = createMemo(() => {
    const owner = connection();
    const [saving, setSaving] = createOptimistic(false);
    return { owner, saving, setSaving };
  });
  let lifetime = Promise.withResolvers<void>();
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<unknown>,
    retired: Promise<void>,
    isCurrent: () => boolean,
  ) {
    if (isCurrent() && view.owner === getConnection()) {
      view.setSaving(true);
    }
    yield Promise.race([pending, retired]);
  });
  return {
    saving: () => presentation().saving(),
    retire() {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    async present(pending: Promise<unknown>, isCurrent: () => boolean) {
      const view = presentation();
      const retired = lifetime.promise;
      // Let the admitted owner's controls mount before joining the transition.
      await Promise.race([
        retired,
        new Promise<void>((resolve) => {
          onSettled(resolve);
        }),
      ]);
      await present(view, pending, retired, isCurrent);
    },
  };
}
