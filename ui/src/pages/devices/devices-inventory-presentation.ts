import {
  action,
  affects,
  createMemo,
  createOptimistic,
  refresh,
  type SourceAccessor,
} from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DevicesPageDataState } from "../../lib/nodes/page-operations.ts";

type InventoryScope = {
  gateway: ApplicationContext["gateway"];
  state: DevicesPageDataState;
  epoch: number;
};

export function createInventoryPresentation(options: {
  scope: () => InventoryScope;
  isCurrent: (scope: InventoryScope) => boolean;
  read: SourceAccessor<void>;
  publish: () => void;
}) {
  let lifetime = Promise.withResolvers<void>();
  const presentation = createMemo(() => {
    const scope = options.scope();
    const [saving, setSaving] = createOptimistic(false);
    return { ...scope, saving, setSaving };
  });
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    const isCurrent = () => retired === lifetime.promise && options.isCurrent(view);
    try {
      if (isCurrent()) {
        view.setSaving(true);
        affects(options.read);
      }
      yield Promise.race([pending, retired]);
      if (isCurrent()) {
        yield refresh(options.read);
      }
    } catch (error) {
      if (isCurrent()) {
        view.state.devicesError = formatUiError(error);
        options.publish();
      }
    }
  });
  return {
    saving: () => presentation().saving(),
    retire(this: void) {
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    run<T>(task: () => Promise<T>) {
      const view = presentation();
      const retired = lifetime.promise;
      const result = task();
      const presented = (async () => {
        // Owner publication must settle before joining the optimistic transition.
        await Promise.resolve();
        await present(view, result, retired);
      })();
      // Rotation consumes the original result even when presentation has retired.
      return { result, presented };
    },
  };
}
