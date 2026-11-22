import type { ModelCatalogEntry } from "../../api/types.ts";
import { canonicalModelAuthProviderId } from "../../lib/model-auth.ts";
import type { ModelCatalogPresentation } from "../../lib/model-catalog-store.ts";
import { t } from "../../lib/reactive/i18n.ts";

function modelRef(model: ModelCatalogEntry): string {
  return `${model.provider}/${model.id}`;
}

export function verifiedStarterModel(
  catalog: ModelCatalogPresentation,
  ref: string,
  authProviderId: string | undefined,
  verifiedName: string | undefined,
): ModelCatalogEntry | undefined {
  const slash = ref.indexOf("/");
  const provider = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  const known = catalog.models.find((model) => model.provider === provider && model.id === id);
  const recommended =
    !catalog.retired &&
    catalog.models.find(
      (model) =>
        canonicalModelAuthProviderId(model.provider) === authProviderId &&
        model.available === true &&
        model.manualSelectionAllowed !== false &&
        model.recommended === true,
    );
  const name = verifiedName ?? known?.name;
  return recommended
    ? { provider: recommended.provider, id: recommended.id, name: recommended.name }
    : name
      ? { provider, id, name }
      : undefined;
}

export function createProviderModelSelection(options: {
  canChoose: () => boolean;
  getModel: () => ModelCatalogEntry | undefined;
  setModel: (model: ModelCatalogEntry | undefined) => void;
  notify: () => void;
}) {
  let models: ModelCatalogEntry[] = [];
  let choosing = false;
  const label = () => t("modelSetup.nativeModels.choose");
  const select = (model: ModelCatalogEntry | undefined) => {
    options.setModel(model);
    options.notify();
  };

  return {
    get choosing() {
      return choosing;
    },
    updateCatalog(
      catalogModels: readonly ModelCatalogEntry[],
      authProviderId: string | undefined,
      activating: boolean,
      verifiedModelRef: string | undefined,
    ) {
      const available = (model: ModelCatalogEntry) =>
        canonicalModelAuthProviderId(model.provider) === authProviderId &&
        model.available === true &&
        model.manualSelectionAllowed !== false;
      const selected = options.getModel();
      if (authProviderId && !activating) {
        models = catalogModels.filter(available);
        select(
          selected ? models.find((model) => modelRef(model) === modelRef(selected)) : undefined,
        );
        return;
      }
      select(
        selected
          ? (catalogModels.find(
              (model) => model.provider === selected.provider && model.id === selected.id,
            ) ?? selected)
          : (catalogModels.find((model) => available(model) && model.recommended === true) ??
              catalogModels.find(
                (model) => available(model) && modelRef(model) === verifiedModelRef,
              )),
      );
    },
    clear() {
      models = [];
      choosing = false;
    },
    action() {
      return models.length && !choosing
        ? {
            label: label(),
            onClick: () => {
              if (!options.canChoose() || !models.length) {
                return;
              }
              choosing = true;
              select(models.find((model) => model.recommended) ?? models[0]);
            },
          }
        : undefined;
    },
    picker() {
      if (!choosing || !models.length) {
        return undefined;
      }
      const selected = options.getModel();
      return {
        label: label(),
        value: selected ? modelRef(selected) : "",
        options: models.map((model) => ({
          value: modelRef(model),
          label: model.name,
          provider: model.provider,
        })),
        disabled: !options.canChoose(),
        onChange: (value: string) => {
          if (options.canChoose()) {
            select(models.find((model) => modelRef(model) === value));
          }
        },
      };
    },
  };
}
