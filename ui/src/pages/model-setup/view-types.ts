import type { SystemAgentSetupDetectResult } from "../../api/types.ts";
import type { JSX } from "../../types/solid-elements.js";
import type { ModelProviderLogin } from "../model-providers/login-controller.ts";
import type { renderProviderIcon } from "./model-setup-icon-loader.tsx";
import type { NativeModelSetup } from "./native-model-setup.tsx";
import type { ModelSetupPrepareOption } from "./prepare-options.ts";
import type {
  ModelSetupActivationState,
  ModelSetupPageState,
  ModelSetupVerifyState,
  ModelSetupWizardState,
} from "./state.ts";

export type ModelSetupViewProps = Parameters<typeof renderProviderIcon>[0] & {
  activation: ModelSetupActivationState;
  actionsDisabled: boolean;
  detecting?: boolean;
  embedded?: boolean;
  onActivateCandidate: (candidate: SystemAgentSetupDetectResult["candidates"][number]) => void;
  connection?: ModelProviderLogin["pageActions"];
  login?: JSX.Element;
  revision?: () => unknown;
  onManualInput?: (element: HTMLInputElement) => void;
  onFeedback?: (element: HTMLDivElement) => void;
  onWizardDialog?: (
    element: import("../../components/modal-dialog.ts").OpenClawModalDialog,
  ) => void;
  agentLabel?: string;
  credentialChoices?: readonly string[];
  onClose?: () => void;
  onDiscoveryShown?: () => void;
  detectionError?: string | null;
  page: ModelSetupPageState;
  verify: ModelSetupVerifyState;
  wizard: ModelSetupWizardState;
  wizardMode: "auth" | "prepare" | "activate";
  wizardValue: unknown;
  canAdmin: boolean;
  canVerify: boolean;
  canPrepare: boolean;
  modelConfigured?: boolean;
  gatewayTooOld: boolean;
  refreshWarning: string | null;
  cancellationNotice?: string | null;
  activationUnresolved?: boolean;
  onUseCurrentModel?: () => void;
  manualProviderId: string;
  manualApiKey: string;
  manualError: string | null;
  moreSignInOpen: boolean;
  firstRun: boolean;
  nativeSessionCatalogsEnabled?: boolean;
  onNativeSessionCatalogsChange?: (enabled: boolean) => void;
  nativeModels?: NativeModelSetup;
  onDetect: () => void;
  onVerify: () => void;
  onStartAuth: (option: NonNullable<SystemAgentSetupDetectResult["authOptions"]>[number]) => void;
  onStartPrepare: (option: ModelSetupPrepareOption) => void;
  onManualProviderChange: (providerId: string) => void;
  onManualApiKeyChange: (apiKey: string) => void;
  onManualConnect: () => void;
  onMoreSignInToggle: (open: boolean) => void;
  onOpenChat: () => void;
  onOpenSetupAssistant?: () => void;
  onSuccessClose: () => void;
  onWizardValueChange: (value: unknown) => void;
  onWizardAnswer: (value: unknown, includeValue?: boolean) => void;
  onWizardCancel: () => void;
  onWizardClose: () => void;
};
