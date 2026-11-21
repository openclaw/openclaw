import type { ModelCatalogEntry } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { selectableRuntimeId } from "../../lib/model-runtime-choice.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { openPreferredApplicationSession } from "../../lib/sessions/route-navigation.ts";

export function createModelProviderStartChat(options: {
  getScope: () => {
    context: ApplicationContext;
    agentId: string | null;
    connectionEpoch: number;
  };
  getGeneration: () => number;
  getModel: () => ModelCatalogEntry | undefined;
  canStart: () => boolean;
  onCreated: () => void;
  onError: (message: string) => void;
  notify: () => void;
}) {
  let pending: AbortController | undefined;

  function reset(): void {
    pending?.abort();
    pending = undefined;
  }

  function start() {
    const model = options.getModel();
    const scope = options.getScope();
    const { context, agentId } = scope;
    if (!model || !agentId || pending || !options.canStart()) {
      return undefined;
    }
    const generation = options.getGeneration();
    const client = context.gateway.snapshot.client;
    const request = new AbortController();
    const isCurrentOwner = () =>
      generation === options.getGeneration() &&
      options.getScope().context.gateway.snapshot.client === client;
    const isCurrent = () => {
      const current = options.getScope();
      return (
        isCurrentOwner() &&
        current.connectionEpoch === scope.connectionEpoch &&
        current.agentId === agentId
      );
    };
    pending = request;
    options.notify();
    const completion = settle(model, agentId);
    return { completion, isCurrent };

    async function settle(
      selectedModel: ModelCatalogEntry,
      selectedAgentId: string,
    ): Promise<void> {
      try {
        const agentRuntime = selectableRuntimeId(selectedModel.agentRuntime);
        const key = await context.sessions.create(
          {
            agentId: selectedAgentId,
            model: `${selectedModel.provider}/${selectedModel.id}`,
            ...(agentRuntime ? { agentRuntime } : {}),
          },
          { signal: request.signal },
        );
        if (!isCurrentOwner()) {
          return;
        }
        if (key) {
          options.onCreated();
          openPreferredApplicationSession(context, key, selectedAgentId);
        } else {
          options.onError(context.sessions.state.error ?? t("modelProviders.requestFailed"));
        }
      } catch (error) {
        if (generation === options.getGeneration()) {
          options.onError(formatUiError(error, t("modelProviders.requestFailed")));
        }
      } finally {
        if (pending === request) {
          pending = undefined;
        }
        if (generation === options.getGeneration()) {
          options.notify();
        }
      }
    }
  }

  return {
    start,
    reset,
    get busy() {
      return pending !== undefined;
    },
  };
}
