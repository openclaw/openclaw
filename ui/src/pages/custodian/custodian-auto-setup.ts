import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupActivateResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import { initialWizardValue } from "../model-setup/state.ts";
import {
  ModelSetupWizardRunner,
  type ModelSetupWizardCompletion,
} from "../model-setup/wizard-runner.ts";
import { resolveCustodianConfiguredInferenceState } from "./custodian-session-variant.ts";

// Wire result for the optional automatic setup capability.
export type SetupAutoCandidate = {
  kind: string;
  label: string;
  detail: string;
  modelRef: string;
  brandId?: string;
  icon?: string;
};
export type SetupAutoResult = {
  status: "configured" | "activated" | "needs-sign-in" | "unavailable";
  selected?: SetupAutoCandidate;
  alternatives: SetupAutoCandidate[];
  attempts: { kind: string; label: string; error: string }[];
  signIn?: { authOptionId: string; label: string };
  installedPlugins: string[];
};

const DISMISSED_KEY = "openclaw.custodian.setup-dismissed.v1:";

/** Connection-owned first-run setup. The Gateway owns selection and verification. */
export class CustodianAutoSetup {
  result: SetupAutoResult | null = null;
  pending = false;
  error: string | null = null;
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
    cancelledMessage: () => t("custodian.cancel"),
    sessionExpiredMessage: () => t("modelSetup.wizard.sessionExpired"),
    gatewayNotRespondingMessage: () => t("modelSetup.wizard.gatewayNotResponding"),
  });

  constructor(private readonly changed: () => void) {}

  get ready(): boolean {
    return this.result?.status === "configured" || this.result?.status === "activated";
  }

  get configuredInferenceState() {
    if (this.blocksGreeting) {
      return "unresolved";
    }
    return this.supported && this.ready
      ? "ready"
      : resolveCustodianConfiguredInferenceState(this.context);
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
      void this.retry();
    }
  }

  async retry(): Promise<void> {
    const client = this.client;
    if (!client || this.pending) {
      return;
    }
    const epoch = ++this.epoch;
    this.pending = true;
    this.error = null;
    this.changed();
    try {
      // Verification and plugin preparation can exceed a minute. The Gateway owns the lifetime.
      const result = await client.request<SetupAutoResult>(
        "openclaw.setup.auto",
        {},
        { timeoutMs: null },
      );
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

  async activate(candidate: SetupAutoCandidate): Promise<void> {
    const client = this.client;
    const previous = this.result;
    if (!client || !previous || this.pending) {
      return;
    }
    const epoch = ++this.epoch;
    this.pending = true;
    this.error = null;
    this.changed();
    try {
      const result = await client.request<SystemAgentSetupActivateResult>(
        "openclaw.setup.activate",
        { kind: candidate.kind },
        { timeoutMs: null },
      );
      if (epoch !== this.epoch || client !== this.client) {
        return;
      }
      if (!result.ok) {
        throw new Error(result.error || t("custodian.autoSetup.failed"));
      }
      this.result = {
        ...previous,
        status: "activated",
        selected: { ...candidate, modelRef: result.modelRef ?? candidate.modelRef },
        alternatives: [
          ...(previous.selected ? [previous.selected] : []),
          ...previous.alternatives.filter((entry) => entry !== candidate),
        ],
      };
      void this.context?.agents.refreshList();
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

  async signIn(): Promise<void> {
    const signIn = this.result?.signIn;
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
    await this.retry();
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
        this.error = formatUiError(error, t("custodian.autoSetup.failed"));
        this.changed();
      }
    }
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
