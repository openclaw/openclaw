import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupDetectResult as SetupDetection } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { activationTargetId, initialWizardValue } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import type { CustodianConfiguredInferenceState } from "./custodian-session-variant.ts";

export type SetupCandidate = SetupDetection["candidates"][number];
export type SetupAuthOption = NonNullable<SetupDetection["authOptions"]>[number];
export type SetupPrepareOption = NonNullable<SetupDetection["prepareOptions"]>[number];
export type SetupManualProvider = SetupDetection["manualProviders"][number];
type SetupAttempt = { key: string; progress?: string; signIn?: true };
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
  /** Detection is in flight. */
  pending = false;
  /** The choice the wizard is running or last ran: candidate kind, option id, or "api-key". */
  attempt: SetupAttempt | null = null;
  nativeSessionCatalogsEnabled = false;
  /** This page tested and saved a choice. */
  connected = false;
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
    return this.connected || this.detection?.setupComplete === true;
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
        this.nativeSessionCatalogsEnabled = false;
        this.connected = false;
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

  /** Detection only reads the Gateway; nothing is tested or saved until the user picks. */
  async retry(): Promise<void> {
    const client = this.client;
    if (!client || this.pending) {
      return;
    }
    const epoch = ++this.epoch;
    const isCurrent = () => epoch === this.epoch && client === this.client;
    this.pending = true;
    this.error = null;
    this.changed();
    try {
      const detection = await client.request<SetupDetection>(
        "openclaw.setup.detect",
        {},
        { timeoutMs: null },
      );
      if (isCurrent()) {
        this.detection = detection;
        this.attempt = null;
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

  /** Native conversation discovery is asked only when the Gateway says a fresh setup needs it. */
  private catalogPreference(): { nativeSessionCatalogsEnabled?: boolean } {
    return this.detection?.nativeSessionCatalogPreferenceRequired
      ? { nativeSessionCatalogsEnabled: this.nativeSessionCatalogsEnabled }
      : {};
  }

  /**
   * Every choice runs as a Gateway wizard, as on the Mac: plugin approvals, sign-in
   * codes and the live test question arrive as steps this card can answer.
   */
  private async begin(
    attempt: SetupAttempt,
    launch: () => Promise<ModelSetupWizardCompletion | null>,
  ): Promise<void> {
    if (!this.client || this.pending || this.testing) {
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
    candidate: Pick<SetupCandidate, "kind" | "label" | "modelRef" | "modelTarget">,
  ): Promise<void> {
    const params = {
      kind: candidate.kind,
      modelRef: candidate.modelRef,
      ...(candidate.modelTarget ? { modelTarget: candidate.modelTarget } : {}),
      ...this.catalogPreference(),
    };
    const progress = t("custodian.autoSetup.testing");
    return this.begin({ key: candidate.kind, progress }, () =>
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
      ...this.catalogPreference(),
    };
    return this.begin({ key: "api-key", progress: t("custodian.autoSetup.testing") }, () =>
      this.wizard.activate(params, "api-key"),
    );
  }

  signIn(option: SetupAuthOption): Promise<void> {
    const progress = t("custodian.autoSetup.startingSignIn");
    return this.begin({ key: option.id, progress, signIn: true }, () => {
      this.wizard.prepareSignIn(option.kind, option.label, option.brandId);
      return this.wizard.start(
        option.id,
        "openclaw.setup.auth.start",
        this.catalogPreference(),
        option.modelTarget,
      );
    });
  }

  prepare(option: SetupPrepareOption): Promise<void> {
    const progress = t("custodian.autoSetup.preparing");
    return this.begin({ key: option.id, progress }, () =>
      this.wizard.start(option.id, "openclaw.setup.prepare.start"),
    );
  }

  private async finish(completion: ModelSetupWizardCompletion): Promise<void> {
    if (completion.isCurrent?.() === false || !this.client) {
      return;
    }
    this.wizard.close();
    if (completion.modelActivation?.modelRef) {
      this.connected = true;
      this.attempt = null;
      void this.context?.agents.refreshList();
      this.changed();
      return;
    }
    // A prepared local model, or a sign-in saved without switching the model: detect
    // again so the new connection is listed, and test the prepared model right away.
    await this.retry();
    const prepared = this.detection?.candidates.find(
      (candidate) => candidate.modelRef === completion.preparedModelRef,
    );
    if (prepared) {
      await this.activate(prepared);
    }
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
    const signIn = this.attempt?.signIn === true;
    return {
      key,
      title: t(
        signIn ? "custodian.autoSetup.signInFailedTitle" : "custodian.autoSetup.testFailedTitle",
      ),
      summary: t(signIn ? "custodian.autoSetup.signInFailed" : "custodian.autoSetup.testFailed"),
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

  async cancelWizard(): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.wizard.requestCancellation();
    } catch (error) {
      if (epoch === this.epoch) {
        this.reportError(error);
      }
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

  setNativeSessionCatalogs(enabled: boolean): void {
    this.nativeSessionCatalogsEnabled = enabled;
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
