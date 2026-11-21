import type { WizardStatusResult } from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ProviderLoginOption, WizardNextResult } from "../../api/types.ts";
import type { FirstRunSetup } from "./first-run-setup.ts";
import type { ModelSetupWizardResult, ModelSetupWizardState } from "./state.ts";

export type ModelSetupWizardStartMethod =
  | "mcp.authLogin"
  | "models.authLogin"
  | "openclaw.setup.auth.start"
  | "openclaw.setup.prepare.start"
  | "openclaw.setup.activate.start"
  | "openclaw.setup.runtime.start";

export type ModelSetupWizardCompletion = {
  startMethod: ModelSetupWizardStartMethod;
  preparedModelRef?: string;
  activationTargetId?: string;
  modelActivation?: WizardNextResult["modelActivation"];
  isCurrent?: () => boolean;
};

export type WizardTerminalObserver = (result: ModelSetupWizardResult) => (() => boolean) | void;

export type WizardRunnerOptions = {
  getClient: () => GatewayBrowserClient | null;
  getAgentId: () => string | null;
  onChange: (state: ModelSetupWizardState) => void;
  onBackgroundCompletion?: (completion: ModelSetupWizardCompletion) => Promise<void>;
  onSessionMissing?: () => void;
  onStart?: (
    method: ModelSetupWizardStartMethod,
    activation?: Parameters<FirstRunSetup["beginActivation"]>[0],
  ) => WizardTerminalObserver | undefined;
  requestFailedMessage: () => string;
  cancelledMessage: () => string;
  sessionExpiredMessage: () => string;
  gatewayNotRespondingMessage: () => string;
};

export type WizardSession = {
  client: GatewayBrowserClient;
  sessionId: string;
  authChoice: string;
  authKind?: ProviderLoginOption["kind"];
  notes: string[];
  reservedWindow?: WindowProxy | null;
  openedUrl?: string;
  externalInputTimer?: ReturnType<typeof setTimeout>;
  externalInputRequest?: Promise<ModelSetupWizardCompletion | null>;
  admitted?: boolean;
  suspended?: boolean;
  retired?: boolean;
  retirementGeneration: number;
  terminalResult?: ModelSetupWizardResult;
  cancellationRequested?: boolean;
  cancellationPromise?: Promise<WizardStatusResult>;
  inputClosurePromise?: Promise<WizardStatusResult>;
  abortController: AbortController;
  startMethod: ModelSetupWizardStartMethod;
  activationTargetId?: string;
  onTerminalResult?: WizardTerminalObserver;
};
