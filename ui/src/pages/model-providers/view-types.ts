import type { JSX } from "../../types/solid-elements.js";
import type { DefaultModelSelection } from "./data.ts";
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
  [Key in keyof ModelProvidersOwnerProps]: Key extends "canConnect"
    ? ModelProvidersOwnerProps[Key]
    : ModelProvidersOwnerProps[Key] extends (...args: infer Args) => unknown
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
  providerQuery?: string;
  /** The page owner supplies the catalog and its entry points. */
  catalogProviders: LoginProvider[];
  onCatalogConnect: (providerId: string) => void;
  discoverDisabled: boolean;
};
