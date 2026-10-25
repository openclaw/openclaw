import {
  action,
  affects,
  createMemo,
  createOptimisticStore,
  onSettled,
  refresh,
  type SourceAccessor,
} from "solid-js";
import type { ModelProviderMutationScope } from "./config-mutation-presentation.ts";
import type { ModelProvidersData } from "./load.ts";
import { showProfileActionError } from "./profiles-view.tsx";

export function createModelProviderProfilePresentation(deps: {
  scope: () => ModelProviderMutationScope;
  isCurrent: (scope: ModelProviderMutationScope) => boolean;
  retirement: () => Promise<void>;
  authStatus: SourceAccessor<ModelProvidersData["authStatus"]>;
}) {
  const presentation = createMemo(() => {
    const scope = deps.scope();
    const [saving, setSaving] = createOptimisticStore<Record<string, boolean>>({});
    return { scope, saving, setSaving };
  });
  const isCurrent = (view: ReturnType<typeof presentation>, retired: Promise<void>) =>
    deps.isCurrent(view.scope) && retired === deps.retirement();
  const presentLogout = action(function* (
    view: ReturnType<typeof presentation>,
    cardId: string,
    completion: Promise<void>,
    retired: Promise<void>,
  ) {
    if (isCurrent(view, retired)) {
      view.setSaving((saving) => {
        saving[cardId] = true;
      });
      affects(deps.authStatus);
    }
    yield Promise.race([completion, retired]);
    if (isCurrent(view, retired)) {
      // The logout owner already refreshed the accepted authentication facts.
      yield refresh(deps.authStatus);
    }
  });

  async function logoutStarted(receipt: { cardId: string; completion: Promise<void> }) {
    const view = presentation();
    const retired = deps.retirement();
    // Let confirmation teardown and owner publication settle before joining.
    await new Promise<void>((resolve) => {
      onSettled(resolve);
    });
    try {
      await presentLogout(view, receipt.cardId, receipt.completion, retired);
    } catch (error) {
      if (isCurrent(view, retired)) {
        showProfileActionError(error);
      }
    }
  }

  return { logoutStarted, logoutSaving: () => presentation().saving };
}
