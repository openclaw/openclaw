import type { ReactiveControllerHost } from "lit";
import type { ModelCatalogResult } from "../../api/types.ts";
import type { DecisionModelEntry } from "../../components/decision-model-picker.ts";
import { t } from "../../i18n/index.ts";
import {
  decisionModelRemovalPatch,
  readDecisionModelInventory,
} from "../../lib/decision-model-inventory.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import { modelDecisionTaskActions, type ModelProviderConfigMutation } from "./config-mutation.ts";
import type { DecisionInventoryViewProps } from "./decision-inventory-view.ts";

export class DecisionInventoryController {
  private removeRef: string | null = null;
  private replacement = "";
  private setupRef: string | null = null;

  constructor(
    private host: ReactiveControllerHost,
    private owner: {
      getConfig: () => Record<string, unknown> | null;
      patchConfig: (mutation: ModelProviderConfigMutation) => Promise<void>;
      getGateway: () => GatewayPageController;
      getBasePath?: () => string;
    },
  ) {}

  reset() {
    this.removeRef = null;
    this.replacement = "";
    this.setupRef = null;
    this.host.requestUpdate();
  }

  private save(
    buildRaw: (config: Readonly<Record<string, unknown>>) => Record<string, unknown> | null,
  ) {
    return this.owner.patchConfig({
      key: "defaults",
      buildFromSnapshot: (config) => {
        const raw = buildRaw(config);
        return raw
          ? {
              options: {
                raw,
                replacePaths: ["models.decisionModels"],
                note: t("chat.modelControls.decisionInventorySaved"),
              },
            }
          : { error: t("modelProviders.configUnavailable") };
      },
    });
  }

  private async remove(ref: string, available: readonly DecisionModelEntry[], replacement: string) {
    const gateway = this.owner.getGateway();
    const scope = gateway.capture();
    await this.save((config) =>
      decisionModelRemovalPatch(readDecisionModelInventory(config, available), ref, replacement),
    );
    if (
      scope &&
      gateway.isCurrent(scope) &&
      this.removeRef === ref &&
      !readDecisionModelInventory(this.owner.getConfig(), available).some(
        (model) => model.ref === ref,
      )
    ) {
      this.reset();
    }
  }

  view(catalog: (ModelCatalogResult & { retired?: boolean }) | undefined) {
    const available = catalog?.decisionModels ?? [];
    const tasks = catalog?.decisionTasks ?? [];
    const catalogOwnsChoices = catalog?.retired || catalog?.modelSelectionPolicy?.restricted;
    const inventory = readDecisionModelInventory(
      catalogOwnsChoices ? null : this.owner.getConfig(),
      available,
    );
    const decisionInventory: Omit<DecisionInventoryViewProps, "disabled"> = {
      inventory,
      available,
      tasks,
      removeRef: catalogOwnsChoices ? null : this.removeRef,
      replacement: catalogOwnsChoices ? "" : this.replacement,
      basePath: this.owner.getBasePath?.(),
      setupRef: catalogOwnsChoices ? null : this.setupRef,
      onSetup: (ref) => {
        this.setupRef = ref;
        this.host.requestUpdate();
      },
      onAdd: (ref) => {
        if (!available.some((model) => `${model.provider}/${model.id}` === ref)) {
          return;
        }
        const gateway = this.owner.getGateway();
        const scope = gateway.capture();
        void this.save((config) => {
          const current = readDecisionModelInventory(config, available);
          return {
            models: { decisionModels: [...new Set([...current.map((model) => model.ref), ref])] },
          };
        }).then(() => {
          if (
            scope &&
            gateway.isCurrent(scope) &&
            this.setupRef === ref &&
            readDecisionModelInventory(this.owner.getConfig(), available).some(
              (model) => model.ref === ref,
            )
          ) {
            this.setupRef = null;
            this.host.requestUpdate();
          }
        });
      },
      onRemove: (ref) => {
        if (inventory.find((model) => model.ref === ref)?.uses.length) {
          this.removeRef = ref;
          this.replacement = "";
          this.host.requestUpdate();
        } else {
          void this.remove(ref, available, "");
        }
      },
      onReplacement: (ref) => {
        this.replacement = ref;
        this.host.requestUpdate();
      },
      onConfirmRemove: () => {
        if (this.removeRef) {
          void this.remove(this.removeRef, available, this.replacement);
        }
      },
      onCancelRemove: () => this.reset(),
    };
    return {
      decisionModels: available.filter((model) =>
        inventory.some((entry) => entry.ref === `${model.provider}/${model.id}`),
      ),
      decisionTasks: tasks,
      decisionInventory,
      ...modelDecisionTaskActions((mutation) => this.owner.patchConfig(mutation)),
    };
  }
}
