import type { JSX } from "../../types/solid-elements.js";
import type { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import type { createModelSetup } from "./model-setup-owner.ts";
import type { ModelSetupDetection } from "./rpc.ts";

type ModelSetupOwnerView = ReturnType<ReturnType<typeof createModelSetup>["view"]>;
type IconProps = Parameters<typeof renderProviderIcon>[0];
type OptionalOwnerProps =
  | "detecting"
  | "embedded"
  | "connection"
  | "onManualInput"
  | "onFeedback"
  | "onWizardDialog"
  | "agentLabel"
  | "credentialChoices"
  | "onClose"
  | "onDiscoveryShown"
  | "modelConfigured"
  | "cancellationNotice"
  | "activationUnresolved"
  | "onUseCurrentModel"
  | "nativeSessionCatalogsEnabled"
  | "onNativeSessionCatalogsChange"
  | "nativeModels"
  | "onOpenSetupAssistant";

export type ModelSetupViewProps = Omit<
  ModelSetupOwnerView,
  OptionalOwnerProps | keyof IconProps | "detectionIdentity"
> &
  Partial<Pick<ModelSetupOwnerView, OptionalOwnerProps>> &
  IconProps & {
    detectionIdentity: () => ModelSetupDetection | undefined;
    login?: JSX.Element;
    revision?: () => unknown;
  };
