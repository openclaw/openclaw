import { action, affects, createMemo, createSignal, onSettled, refresh } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelDefaultsSaveField } from "./config-mutation.ts";
import type { ModelProvidersData } from "./load.ts";

export type ModelProviderMutationScope = {
  client: GatewayBrowserClient | null;
  connectionEpoch: number;
  agentId: string;
  agentEpoch: number;
};

export function createModelProviderMutationPresentation(deps: {
  readScope: () => ModelProviderMutationScope;
  isCurrent: (scope: ModelProviderMutationScope) => boolean;
  readAuthStatus: () => ModelProvidersData["authStatus"];
  readConfigObject: () => Record<string, unknown> | null;
}) {
  let lifetime = Promise.withResolvers<void>();
  const scope = createMemo(deps.readScope, {
    equals: (previous, next) =>
      previous.client === next.client &&
      previous.connectionEpoch === next.connectionEpoch &&
      previous.agentId === next.agentId &&
      previous.agentEpoch === next.agentEpoch,
  });
  const authStatus = createMemo(deps.readAuthStatus);
  const configObject = createMemo(deps.readConfigObject);
  const presentation = createMemo(() => {
    const owner = scope();
    const [defaultsSaving, setDefaultsSaving] = createSignal<{
      field: ModelDefaultsSaveField;
      retired: Promise<void>;
    } | null>(null);
    return { owner, defaultsSaving, setDefaultsSaving };
  });
  const isCurrent = (view: ReturnType<typeof presentation>, retired: Promise<void>) =>
    deps.isCurrent(view.owner) && retired === lifetime.promise;
  const currentDefaultsSave = () => {
    const view = presentation();
    const saving = view.defaultsSaving();
    return saving && isCurrent(view, saving.retired) ? saving : null;
  };
  const present = action(function* (
    view: ReturnType<typeof presentation>,
    kind: "apiKey" | ModelDefaultsSaveField,
    pending: Promise<unknown>,
    retired: Promise<void>,
  ) {
    if (isCurrent(view, retired)) {
      if (kind === "apiKey") {
        // Credential verification determines the accepted auth facts.
        affects(authStatus);
      } else {
        affects(configObject);
      }
    }
    yield Promise.race([pending, retired]);
    if (isCurrent(view, retired)) {
      // The existing mutation already reconciles the owner's snapshot.
      yield refresh(kind === "apiKey" ? authStatus : configObject);
    }
  });

  async function run<T>(
    kind: "apiKey" | ModelDefaultsSaveField,
    operation: (onAdmitted: () => void) => Promise<T>,
    reportError: (error: unknown) => void,
  ): Promise<T | undefined> {
    const view = presentation();
    const retired = lifetime.promise;
    const defaultsSave = kind === "apiKey" ? null : { field: kind, retired };
    try {
      const pending = operation(() => {
        if (defaultsSave && isCurrent(view, retired)) {
          // Publish the initiating field with admission, before the owner's busy frame.
          view.setDefaultsSaving(defaultsSave);
        }
      });
      // Let owner publication and any just-opened modal settle before joining.
      await new Promise<void>((resolve) => {
        onSettled(resolve);
      });
      await present(view, kind, pending, retired);
      return await pending;
    } catch (error) {
      if (isCurrent(view, retired)) {
        reportError(error);
      }
      return undefined;
    } finally {
      if (defaultsSave && isCurrent(view, retired) && view.defaultsSaving() === defaultsSave) {
        view.setDefaultsSaving(null);
      }
    }
  }

  return {
    scope,
    isCurrent: deps.isCurrent,
    authStatus,
    configObject,
    retirement: () => lifetime.promise,
    retire() {
      presentation().setDefaultsSaving(null);
      lifetime.resolve();
      lifetime = Promise.withResolvers<void>();
    },
    run,
    defaultsSaving: () => currentDefaultsSave() !== null,
    defaultsSavingField: () => currentDefaultsSave()?.field ?? null,
  };
}
