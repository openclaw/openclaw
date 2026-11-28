import type { JSX } from "../../types/solid-elements.js";
import type { DefaultModelSelection, ModelProviderCard } from "./data.ts";
import type { DefaultModelsViewProps } from "./default-models-view.tsx";
import type { LoginProvider } from "./login-providers.ts";
import type { ModelProvidersOwner } from "./model-providers-controller.ts";
import type { ProviderProfilesViewProps } from "./profiles-view.tsx";

type SharedModelProvidersProps = Omit<DefaultModelsViewProps, "models" | "selection" | "message"> &
  ProviderProfilesViewProps;
type ModelProvidersOwnerProps = Omit<
  ReturnType<ModelProvidersOwner["viewProps"]>["props"],
  keyof SharedModelProvidersProps | "installedAgents" | "defaultModels" | "providerQuery"
>;

export type ModelProvidersViewProps = SharedModelProvidersProps & {
  [Key in keyof ModelProvidersOwnerProps]: ModelProvidersOwnerProps[Key] extends (
    ...args: infer Args
  ) => unknown
    ? (...args: Args) => void
    : ModelProvidersOwnerProps[Key];
} & {
  defaultModels: DefaultModelSelection;
  loading: boolean;
  catalogDiscovering: boolean;
  catalogDiscoveryError: string | null;
  providerDetailsReady?: boolean;
  installedAgents: JSX.Element | typeof undefined;
  accountRecovery?: JSX.Element | typeof undefined;
  /** First-run recovery and detected models, above the catalog. */
  firstRunSetup?: JSX.Element | typeof undefined;
  /** A first-run activation may still commit; catalog sign-in waits for its recovery. */
  firstRunUnresolved?: boolean;
  providerQuery?: string;
  /** The page owner supplies the catalog and its entry points. */
  catalogProviders: LoginProvider[];
  canConnect: (card: ModelProviderCard) => boolean;
  onCatalogConnect: (providerId: string) => void;
  discoverDisabled: boolean;
};
