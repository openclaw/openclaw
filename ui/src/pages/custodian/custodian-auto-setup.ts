import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult as SetupDetection } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import {
  activationTargetId,
  candidateActivation,
  initialWizardValue,
  preparedModelActivation,
} from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import type { CustodianConfiguredInferenceState } from "./custodian-session-variant.ts";

export type SetupCandidate = SetupDetection["candidates"][number];
export type SetupAuthOption = NonNullable<SetupDetection["authOptions"]>[number];
export type SetupPrepareOption = NonNullable<SetupDetection["prepareOptions"]>[number];
export type SetupManualProvider = SetupDetection["manualProviders"][number];
type SetupAttempt = {
  key: string;
  /** The name the user picked, such as ChatGPT, for the finished card. */
  label: string;
  progress?: string;
  signIn?: true;
  prepareOption?: SetupPrepareOption;
};
/** What this page connected: the finished card names it. */
export type SetupConnection = { label: string; modelRef: string; shared: boolean };
export type SetupStep = "welcome" | "where" | "ai";
/** One short sentence for the card; the Gateway's own text stays behind Show details. */
export type SetupFailure = { title: string; summary: string; detail?: string };

const DISMISSED_KEY = "openclaw.custodian.setup-dismissed.v1:";

/**
 * Connection-owned first-run setup, in the macOS welcome order: the Gateway detects
 * usable AI, the user picks one, and the Gateway tests and saves only that choice.
 */
export class CustodianAutoSetup {
  step: SetupStep = "welcome";
  detection: SetupDetection | null = null;
  /** Detection is in flight; known choices may already be listed. */
  pending = false;
  /** The choice the wizard is running or last ran: candidate kind, option id, or "api-key". */
  attempt: SetupAttempt | null = null;
  /** This page tested and saved a choice. */
  connection: SetupConnection | null = null;
  error: SetupFailure | null = null;
  dismissed = false;
  supported = false;
  wizardValue: unknown;
  wizardSecretVisible = false;
  private context: ApplicationContext | null = null;
  private client: GatewayBrowserClient | null = null;
  private ownerKey: string | null = null;
  private dismissalKey = "";
  private epoch = 0;
  private started = false;
  private synchronizing = false;
  private wizardStepId: string | null = null;

  readonly wizard = new ModelSetupWizardRunner({
    getClient: () => this.client,
    getAgentId: () => null,
    onChange: (state) => {
      if (state.phase === "step" && state.step.id !== this.wizardStepId) {
        this.wizardStepId = state.step.id;
        this.wizardValue = initialWizardValue(state.step);
      }
      if (!this.synchronizing) {
        this.changed();
      }
    },
    onBackgroundCompletion: (completion) => this.finish(completion),
    requestFailedMessage: () => t("custodian.autoSetup.failed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });

  constructor(private readonly changed: () => void) {}

  get operationEpoch(): number {
    return this.epoch;
  }

  /**
   * Done once a pick is activated here or the Gateway reports a configured model. A fresh
   * Gateway's agent always names an implicit default model, so that alone proves nothing.
   */
  get ready(): boolean {
    return this.connection !== null || this.detection?.setupComplete === true;
  }

  private selectedAgent() {
    const context = this.context;
    const agentsList = context?.agents.state.agentsList;
    if (!context || !agentsList) {
      return undefined;
    }
    const selectedId = normalizeAgentId(
      context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
    );
    return agentsList.agents.find((agent) => normalizeAgentId(agent.id) === selectedId);
  }

  setStep(step: SetupStep): void {
    this.step = step;
    this.changed();
  }

  get configuredInferenceState(): CustodianConfiguredInferenceState {
    if (this.blocksGreeting) {
      return "unresolved";
    }
    if (this.supported && this.ready) {
      return "ready";
    }
    if (this.context?.gateway.snapshot.phase !== "connected") {
      return "unresolved";
    }
    const selectedAgent = this.selectedAgent();
    if (!selectedAgent) {
      return "unresolved";
    }
    return selectedAgent.model?.primary?.trim()
      ? "ready"
      : selectedAgent.utilityModel?.trim()
        ? "utility"
        : "required";
  }

  get blocksGreeting(): boolean {
    return this.supported && !this.ready;
  }

  synchronize(context: ApplicationContext, onboarding: boolean, ownerKey: string): void {
    const snapshot = context.gateway.snapshot;
    const supported =
      onboarding && isGatewayMethodAdvertised(snapshot, "openclaw.setup.detect") === true;
    const client = supported && snapshot.phase === "connected" ? snapshot.client : null;
    const ownerChanged = ownerKey !== this.ownerKey;
    if (ownerChanged || client !== this.client || supported !== this.supported) {
      this.epoch += 1;
      this.pending = false;
      this.synchronizing = true;
      this.wizard.close({ retireOwner: true });
      this.wizardStepId = null;
      this.synchronizing = false;
      if (ownerChanged) {
        this.step = "welcome";
        this.detection = null;
        this.attempt = null;
        this.connection = null;
        this.error = null;
        this.started = false;
        this.dismissalKey = DISMISSED_KEY + context.gateway.connection.gatewayUrl;
        try {
          this.dismissed = getSafeLocalStorage()?.getItem(this.dismissalKey) === "1";
        } catch {
          this.dismissed = false;
        }
      } else if (!this.detection) {
        // A disconnected request may still be running on the Gateway; rejoin its single flight.
        this.started = false;
      }
    }
    this.context = context;
    this.ownerKey = ownerKey;
    this.client = client;
    this.supported = supported;
    if (client && !this.started) {
      this.started = true;
      void this.retry();
    }
  }

  /**
   * Detection only reads the Gateway; nothing is tested or saved until the user picks. As on
   * the Mac, sign-ins and keys are listed from config while local discovery still runs.
   */
  async retry(): Promise<void> {
    const client = this.client;
    if (!client) {
      return;
    }
    const epoch = ++this.epoch;
    const isCurrent = () => epoch === this.epoch && client === this.client;
    this.pending = true;
    this.error = null;
    if (!this.testing) {
      this.attempt = null;
    }
    this.changed();
    void client.request<SetupDetection>("openclaw.setup.options", {}, { timeoutMs: null }).then(
      (options) => {
        if (isCurrent() && this.pending && !this.detection) {
          this.detection = options;
          this.changed();
        }
      },
      () => undefined,
    );
    try {
      const detection = await client.request<SetupDetection>(
        "openclaw.setup.detect",
        {},
        { timeoutMs: null },
      );
      if (isCurrent()) {
        this.detection = detection;
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = {
          title: t("custodian.autoSetup.detectFailedTitle"),
          summary: t("custodian.autoSetup.detectFailed"),
          detail: formatUiError(error, t("custodian.autoSetup.failed")),
        };
      }
    } finally {
      if (isCurrent()) {
        this.pending = false;
        this.changed();
      }
    }
  }

  /**
   * Every choice runs as a Gateway wizard, as on the Mac: plugin approvals, sign-in
   * codes and the live test question arrive as steps this card can answer.
   */
  private async begin(
    attempt: SetupAttempt,
    launch: () => Promise<ModelSetupWizardCompletion | null>,
  ): Promise<void> {
    if (!this.client || this.testing) {
      return;
    }
    this.wizard.close();
    this.wizardStepId = null;
    this.attempt = attempt;
    this.changed();
    const epoch = this.epoch;
    const completion = await launch();
    if (epoch === this.epoch && completion) {
      await this.finish(completion);
    }
  }

  activate(
    candidate: Pick<SetupCandidate, "kind" | "modelRef" | "modelTarget">,
    label: string,
  ): Promise<void> {
    const params = {
      ...candidateActivation(candidate),
      // Like automatic setup: reuse the Codex login instead of a second sign-in.
      ...(candidate.kind === "codex-cli" ? { shareCodexLogin: true as const } : {}),
    };
    const progress = t("custodian.autoSetup.testing");
    return this.begin({ key: candidate.kind, label, progress }, () =>
      this.wizard.activate(params, activationTargetId(candidate.kind, candidate.modelRef)),
    );
  }

  /** The key goes to the Gateway once and is never kept in this owner. */
  connectKey(provider: SetupManualProvider, apiKey: string): Promise<void> {
    const params = {
      kind: "api-key" as const,
      authChoice: provider.id,
      apiKey,
      ...(provider.modelTarget ? { modelTarget: provider.modelTarget } : {}),
    };
    const label = provider.groupLabel ?? provider.label;
    return this.begin({ key: "api-key", label, progress: t("custodian.autoSetup.testing") }, () =>
      this.wizard.activate(params, "api-key"),
    );
  }

  signIn(option: SetupAuthOption, label = option.label): Promise<void> {
    const progress = t("custodian.autoSetup.startingSignIn");
    return this.begin({ key: option.id, label, progress, signIn: true }, () => {
      this.wizard.prepareSignIn(option.kind, option.label, option.brandId);
      return this.wizard.start(option.id, "openclaw.setup.auth.start", {}, option.modelTarget);
    });
  }

  prepare(option: SetupPrepareOption): Promise<void> {
    const progress = t("custodian.autoSetup.preparing");
    const attempt = { key: option.id, label: option.label, progress, prepareOption: option };
    return this.begin(attempt, () => this.wizard.start(option.id, "openclaw.setup.prepare.start"));
  }

  private async finish(completion: ModelSetupWizardCompletion): Promise<void> {
    if (completion.isCurrent?.() === false || !this.client) {
      return;
    }
    this.wizard.close();
    const modelRef = completion.modelActivation?.modelRef;
    if (modelRef) {
      this.connection = {
        label: this.attempt?.label ?? modelRef,
        modelRef,
        shared: this.attempt?.key === "codex-cli",
      };
      this.attempt = null;
      void this.context?.agents.refreshList();
      this.changed();
      return;
    }
    const prepareOption = this.attempt?.prepareOption;
    if (prepareOption && completion.preparedModelRef) {
      // Discovery lists loaded models. The wizard returns the exact model the user prepared.
      await this.activate(
        preparedModelActivation(prepareOption, completion.preparedModelRef),
        prepareOption.label,
      );
      return;
    }
    // A sign-in can complete without switching models. Refresh the available choices.
    await this.retry();
  }

  /** The choice being worked on, while the Gateway runs it. */
  get testing(): string | null {
    const phase = this.wizard.state.phase;
    return phase === "starting" || phase === "step" ? (this.attempt?.key ?? null) : null;
  }

  /** The wizard's own text can be long and internal; the card shows one sentence. */
  get attemptFailure(): (SetupFailure & { key: string }) | null {
    const state = this.wizard.state;
    const key = this.attempt?.key ?? "";
    if (state.phase === "cancelled") {
      return { key, title: state.message, summary: "" };
    }
    if (state.phase !== "error") {
      return null;
    }
    const kind = this.attempt?.signIn ? "signIn" : key === "api-key" ? "key" : "test";
    return {
      key,
      title: t(`custodian.autoSetup.${kind}FailedTitle`),
      summary: t(`custodian.autoSetup.${kind}Failed`),
      detail: state.message,
    };
  }

  async answerWizard(value: unknown): Promise<void> {
    const epoch = this.epoch;
    const completion = await this.wizard.answer(value, value !== undefined);
    if (epoch === this.epoch && completion) {
      await this.finish(completion);
    }
  }

  async cancelWizard(): Promise<boolean> {
    const epoch = this.epoch;
    try {
      return (await this.wizard.requestCancellation()) === "cancelled";
    } catch (error) {
      if (epoch === this.epoch) {
        this.reportError(error);
      }
      return false;
    }
  }

  reportError(error: unknown): void {
    this.error = {
      title: t("custodian.autoSetup.failedTitle"),
      summary: t("custodian.autoSetup.failed"),
      detail: formatUiError(error, t("custodian.autoSetup.failed")),
    };
    this.changed();
  }

  setWizardValue(value: unknown): void {
    this.wizardValue = value;
    this.changed();
  }

  toggleWizardSecretVisibility(): void {
    this.wizardSecretVisible = !this.wizardSecretVisible;
    this.changed();
  }

  dismiss(): void {
    this.dismissed = true;
    try {
      getSafeLocalStorage()?.setItem(this.dismissalKey, "1");
    } catch {
      // Dismissal still lasts for this store when browser storage is unavailable.
    }
    this.changed();
  }
}
