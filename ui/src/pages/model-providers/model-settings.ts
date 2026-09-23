import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReactiveControllerHost } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { peekModelCatalog } from "../../lib/model-catalog-store.ts";
import { readModelBehaviorConfig, type ModelBehaviorConfig } from "./config-mutation.ts";
import { readModelProviderConfig, type DefaultModelSelection } from "./data.ts";
import { DecisionModelSetupController } from "./decision-setup-controller.ts";

type ModelDefaults = DefaultModelSelection & ModelBehaviorConfig;

/** Bind the global selector and setup intent to current config/catalog owners, not a render snapshot. */
export function createGlobalModelSettings(
  host: ReactiveControllerHost,
  options: {
    getScope: () => { context: ApplicationContext; agentId: string | null };
    getDraft: () => ModelDefaults | null;
    onChange: (defaults: ModelDefaults) => void;
  },
) {
  const readDefaults = () => {
    const config = currentConfigObject(options.getScope().context.runtimeConfig.state);
    return {
      ...readModelProviderConfig(config).defaults,
      ...readModelBehaviorConfig(asRecord(asRecord(config?.agents)?.defaults)),
    };
  };
  const catalog = () => {
    const { context, agentId } = options.getScope();
    const client = context.gateway.snapshot.client;
    return client && agentId
      ? peekModelCatalog(client, { agentId }, { allowStale: true })
      : undefined;
  };
  const decisionModels = () => catalog()?.decisionModels ?? [];
  const decision = new DecisionModelSetupController(host, {
    getScope: options.getScope,
    getModels: decisionModels,
    getSelection: () => {
      const draft = options.getDraft();
      return draft ? draft.decisionModel : readDefaults().decisionModel;
    },
  });
  const currentDefaults = () => options.getDraft() ?? readDefaults();
  const stageDefaults = (patch: Partial<ModelDefaults>) =>
    options.onChange({ ...currentDefaults(), ...patch });
  return { catalog, currentDefaults, decisionModels, decision, stageDefaults };
}
