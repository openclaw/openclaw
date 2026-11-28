import type {
  SystemAgentSetupAutoCandidate as SetupAutoCandidate,
  SystemAgentSetupAutoResult as SetupAutoResult,
} from "../../../../packages/gateway-protocol/src/schema/setup-inference.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  SystemAgentSetupActivateResult,
  SystemAgentSetupDetectResult,
} from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { initialWizardValue, MODEL_SETUP_DETECT_TIMEOUT_MS } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import type { CustodianConfiguredInferenceState } from "./custodian-session-variant.ts";

export type { SetupAutoCandidate, SetupAutoResult };

/** Detected first-run access waiting for the person's choice; nothing is active yet. */
export type SetupChoiceResult = Omit<SetupAutoResult, "status"> & { status: "choose" };

const DISMISSED_KEY = "openclaw.custodian.setup-dismissed.v1:";

/**
 * Connection-owned first-run setup. The Gateway owns detection and verification;
 * opening only detects. Activation follows the person's choice, and the
 * automatic ladder runs only when they request it.
 */
export class CustodianAutoSetup {
  result: SetupAutoResult | SetupChoiceResult | null = null;
  pending = false;
  error: string | null = null;
  /** The person's unfinished choice; Retry repeats it instead of trying another route. */
  private retryChoice: SetupAutoCandidate | null = null;
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
    onBackgroundCompletion: (completion) => this.finishSignIn(completion),
    requestFailedMessage: () => t("custodian.autoSetup.failed"),
    cancelledMessage: () => t("modelSetup.wizard.cancelled"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });

  constructor(private readonly changed: () => void) {}

  get operationEpoch(): number {
    return this.epoch;
  }

  get ready(): boolean {
    return this.result?.status === "configured" || this.result?.status === "activated";
  }

  get configuredInferenceState(): CustodianConfiguredInferenceState {
    if (this.blocksGreeting) {
      return "unresolved";
    }
    if (this.supported && this.ready) {
      return "ready";
    }
    const context = this.context;
    if (!context || context.gateway.snapshot.phase !== "connected") {
      return "unresolved";
    }
    const agentsList = context.agents.state.agentsList;
    if (!agentsList) {
      return "unresolved";
    }
    const selectedId = normalizeAgentId(
      context.gateway.snapshot.assistantAgentId ?? agentsList.defaultId ?? "",
    );
    const selectedAgent = agentsList.agents.find(
      (agent) => normalizeAgentId(agent.id) === selectedId,
    );
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
    return this.supported && (!this.ready || this.pending);
  }

  synchronize(context: ApplicationContext, onboarding: boolean, ownerKey: string): void {
    const snapshot = context.gateway.snapshot;
    const supported =
      onboarding && isGatewayMethodAdvertised(snapshot, "openclaw.setup.auto") === true;
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
        this.result = null;
        this.error = null;
        this.retryChoice = null;
        this.started = false;
        this.dismissalKey = DISMISSED_KEY + context.gateway.connection.gatewayUrl;
        try {
          this.dismissed = getSafeLocalStorage()?.getItem(this.dismissalKey) === "1";
        } catch {
          this.dismissed = false;
        }
      } else if (!this.result) {
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
      void this.refresh();
    }
  }

  private async run(
    task: (client: GatewayBrowserClient) => Promise<SetupAutoResult | SetupChoiceResult>,
  ): Promise<void> {
    const client = this.client;
    if (!client || this.pending) {
      return;
    }
    const epoch = ++this.epoch;
    this.pending = true;
    this.error = null;
    this.changed();
    try {
      const result = await task(client);
      if (epoch !== this.epoch || client !== this.client) {
        return;
      }
      this.result = result;
      if (this.ready) {
        void this.context?.agents.refreshList();
      }
    } catch (error) {
      if (epoch === this.epoch && client === this.client) {
        this.error = formatUiError(error, t("custodian.autoSetup.failed"));
      }
    } finally {
      if (epoch === this.epoch && client === this.client) {
        this.pending = false;
        this.changed();
      }
    }
  }

  /** Detection is not consent: show the configured model or the detected choices. */
  private refresh(): Promise<void> {
    return this.run(async (client) => {
      this.retryChoice = null;
      const detected = await client.request<SystemAgentSetupDetectResult>(
        "openclaw.setup.detect",
        {},
        { timeoutMs: MODEL_SETUP_DETECT_TIMEOUT_MS },
      );
      if (detected.setupComplete) {
        // With a configured model, setup.auto only reports it, including a shared Codex login.
        // Accepted edge: removing the model between these two reads lets the Gateway choose.
        return client.request<SetupAutoResult>("openclaw.setup.auto", {}, { timeoutMs: null });
      }
      const alternatives = detected.candidates
        .filter((entry) => entry.modelTarget !== "utility" && entry.credentials !== false)
        .toSorted((a, b) => Number(b.recommended) - Number(a.recommended));
      return { status: "choose", alternatives, attempts: [], installedPlugins: [] };
    });
  }

  retry(): Promise<void> {
    return this.retryChoice ? this.activate(this.retryChoice) : this.refresh();
  }

  /** Explicit request: the Gateway tries detected routes in order and may prepare Codex. */
  setUpAutomatically(): Promise<void> {
    // Verification and plugin preparation can exceed a minute. The Gateway owns the lifetime.
    return this.run((client) => {
      this.retryChoice = null;
      return client.request<SetupAutoResult>("openclaw.setup.auto", {}, { timeoutMs: null });
    });
  }

  async activate(candidate: SetupAutoCandidate): Promise<void> {
    const previous = this.result;
    if (!previous) {
      return;
    }
    await this.run(async (client) => {
      this.retryChoice = candidate;
      const result = await client.request<SystemAgentSetupActivateResult>(
        "openclaw.setup.activate",
        { kind: candidate.kind, modelRef: candidate.modelRef },
        { timeoutMs: null },
      );
      if (!result.ok) {
        throw new Error(
          t("custodian.autoSetup.choiceFailed", {
            label: candidate.label,
            error: result.error || t("custodian.autoSetup.failed"),
          }),
        );
      }
      this.retryChoice = null;
      return {
        ...previous,
        status: "activated",
        selected: { ...candidate, modelRef: result.modelRef ?? candidate.modelRef },
        alternatives: [
          ...(previous.selected ? [previous.selected] : []),
          ...previous.alternatives.filter((entry) => entry !== candidate),
        ],
      };
    });
  }

  async signIn(): Promise<void> {
    const signIn = this.result?.selected?.shared ? this.result.separateSignIn : this.result?.signIn;
    if (!this.client || !signIn || this.pending) {
      return;
    }
    this.wizard.close();
    this.wizardStepId = null;
    this.wizard.prepareSignIn("oauth", signIn.label);
    const epoch = this.epoch;
    const completion = await this.wizard.start(signIn.authOptionId);
    if (epoch === this.epoch && completion) {
      await this.finishSignIn(completion);
    }
  }

  private async finishSignIn(completion: ModelSetupWizardCompletion): Promise<void> {
    if (completion.isCurrent?.() === false || !this.client) {
      return;
    }
    this.wizard.close();
    await this.refresh();
  }

  async answerWizard(value: unknown): Promise<void> {
    const epoch = this.epoch;
    const completion = await this.wizard.answer(value, value !== undefined);
    if (epoch === this.epoch && completion) {
      await this.finishSignIn(completion);
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
    this.error = formatUiError(error, t("custodian.autoSetup.failed"));
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
