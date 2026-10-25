import type { JSX } from "../../types/solid-elements.js";
import type { DefaultModelSelection } from "./data.ts";
import type { DefaultModelsViewProps } from "./default-models-view.tsx";
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
  providerScope?: JSX.Element;
  accountRecovery?: JSX.Element | typeof undefined;
  providerQuery?: string;
};
