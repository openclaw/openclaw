import type { ModelAuthStatusResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { canonicalModelAuthProviderId, loadModelAuthStatus } from "../../lib/model-auth.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  clearFirstRunActivationReceipt,
  type FirstRunActivationReceipt,
  hasFirstRunActivationReceipt,
  persistFirstRunActivationReceipt,
  readFirstRunActivationReceipt,
} from "../model-setup/first-run-activation-receipt.ts";
import type { ModelSetupWizardRecovery, ModelSetupWizardResult } from "../model-setup/state.ts";
import type {
  ModelSetupWizardCompletion,
  ModelSetupWizardRunner,
  ModelSetupWizardStartMethod,
} from "../model-setup/wizard-runner.ts";
import type { LoginChoice } from "./login-providers.ts";

type LoginScope = {
  context: ApplicationContext;
  agentId: string | null;
  authStatus?: ModelAuthStatusResult | null;
};

/**
 * The running provider sign-in: its choice, and its recovery while the user is away on
 * the provider's page. The Gateway session outlives the socket, and the existing
 * activation record lets a reloaded page reopen the same session. Owners' resets on a
 * connection or agent change keep a sign-in its owner can resume, and a reopened
 * sign-in shows in front of a provider picker the page's route opened.
 */
export function createLoginSignIn(
  page: { getScope: () => LoginScope; canContinue: () => boolean },
  host: {
    runner: ModelSetupWizardRunner;
    /** `settling` lets a resumed sign-in replace the request chain of a closed socket. */
    run: (
      task: () => Promise<ModelSetupWizardCompletion | null>,
      settling?: boolean,
    ) => Promise<void>;
    reset: () => void;
    synchronizePresentation: () => void;
    /** Whether a sign-in from this page may select a model. */
    allowSetup: () => boolean;
    loginProviders: (
      providers: undefined,
      authStatus: ModelAuthStatusResult | null,
      allowSetup: boolean,
    ) => Array<{ choices: LoginChoice[] }>;
  },
) {
  const { runner } = host;
  let mode: "auth" | "activate" | "access" = "auth";
  let authProviderId: string | undefined;
  let authProviderLabel: string | undefined;
  // The last started sign-in, so a typed failure can offer to start it again.
  let lastSignIn: { selectModel: boolean; restart: () => void } | undefined;
  // Who started the running sign-in. Only the same owner resumes it after a reconnect.
  let owner: { recoveryScope: string | null; agentId: string | null } | undefined;
  // The record of the running sign-in, cleared once the Gateway no longer has it.
  let record: FirstRunActivationReceipt | null = null;
  let restoring = false;
  let resumeAdmission: object | undefined;

  const receiptContext = ({ context, agentId }: LoginScope) => ({
    gateway: context.gateway,
    agentSelection: { state: { selectedId: agentId } },
  });

  function own(scope: LoginScope): void {
    owner = {
      recoveryScope: scope.context.gateway.snapshot.hello?.auth?.recoveryScope ?? null,
      agentId: scope.agentId,
    };
  }

  function observe(receipt: FirstRunActivationReceipt | null) {
    return (result: ModelSetupWizardResult) => {
      if (result.done) {
        clearFirstRunActivationReceipt(receipt);
      }
    };
  }

  function adopt(selected: LoginChoice, allowSetup: boolean): void {
    const kind = selected.kind;
    if (kind === "setup-secret") {
      return;
    }
    authProviderId = canonicalModelAuthProviderId(selected.authProvider);
    authProviderLabel = kind === "secret" ? undefined : selected.groupLabel;
    // Browser and device sign-ins can select a model; a pasted secret only saves. A
    // credential-only sign-in still succeeds when its account offers no usable model.
    const selectModel = allowSetup && kind !== "secret";
    mode = selected.requiresSetup ? (selectModel ? "activate" : "access") : "auth";
    const { id, label, brandId } = selected;
    lastSignIn = {
      selectModel,
      restart: () => {
        runner.prepareSignIn(kind, label, brandId);
        void host.run(() =>
          runner.start(id, "models.authLogin", selectModel ? { selectModel } : {}),
        );
      },
    };
  }

  function onStart(
    method: ModelSetupWizardStartMethod,
    intent?: { kind: string; wizard?: ModelSetupWizardRecovery },
  ) {
    if (method !== "models.authLogin" || !intent?.wizard) {
      return undefined;
    }
    const scope = page.getScope();
    own(scope);
    record = persistFirstRunActivationReceipt(receiptContext(scope), {
      kind: intent.kind,
      wizard: { ...intent.wizard, selectModel: lastSignIn?.selectModel },
    });
    return observe(record);
  }

  /** Follows the Gateway connection: suspends, resumes or reopens the running sign-in. */
  function synchronize(): void {
    host.synchronizePresentation();
    if (!owner || !runner.hasAdmittedSession) {
      reopen();
      return;
    }
    const { context, agentId } = page.getScope();
    const snapshot = context.gateway.snapshot;
    if (snapshot.phase !== "connected") {
      if (!runner.isSuspended) {
        runner.suspend(t("modelSetup.wizard.gatewayReconnecting"));
      }
      return;
    }
    if (!agentId) {
      return;
    }
    if (
      owner.agentId !== agentId ||
      (runner.isSuspended &&
        (!owner.recoveryScope ||
          owner.recoveryScope !== (snapshot.hello?.auth?.recoveryScope ?? null)))
    ) {
      // Another agent, or a reconnect as another identity, can neither continue nor
      // cancel this sign-in.
      runner.close({ retireOwner: true });
      host.reset();
      return;
    }
    if (runner.isSuspended && page.canContinue()) {
      resume();
    }
  }

  /** Any error after a resume means the Gateway no longer has the sign-in: forget it. */
  function resume(): void {
    if (resumeAdmission) {
      return;
    }
    // Admission publishes before the runner clears its suspended state. Claim it
    // first so those publications cannot enqueue another resume of the same sign-in.
    const admission = {};
    resumeAdmission = admission;
    const release = () => {
      if (resumeAdmission === admission) {
        resumeAdmission = undefined;
      }
    };
    void host
      .run(() => {
        const completion = runner.resume();
        release();
        return completion;
      }, true)
      .then(() => {
        if (runner.state.phase === "error" && !runner.hasAdmittedSession) {
          clearFirstRunActivationReceipt(record);
        }
      })
      .finally(release);
  }

  /** A sign-in recorded before a reload reopens once this page can continue it. */
  function reopen(): void {
    // Pages without a Models sign-in record never read scope: that read can load config.
    if (
      restoring ||
      runner.state.phase !== "idle" ||
      !hasFirstRunActivationReceipt("provider-login")
    ) {
      return;
    }
    const { context, agentId } = page.getScope();
    if (context.gateway.snapshot.phase === "connected" && agentId) {
      restoring = true;
      void restore().finally(() => (restoring = false));
    }
  }

  async function restore(): Promise<void> {
    const scope = page.getScope();
    const { context, agentId } = scope;
    const client = context.gateway.snapshot.client;
    // Reading validates the record; an invalid or expired one is removed here.
    const receipt = readFirstRunActivationReceipt(receiptContext(scope));
    const recovery = receipt?.kind === "provider-login" ? receipt.wizard : undefined;
    if (!client || !agentId || !recovery) {
      return;
    }
    let authStatus = scope.authStatus ?? null;
    try {
      // Setup admission needs the config the page is still loading.
      const [status] = await Promise.all([
        authStatus ?? loadModelAuthStatus(client, { agentId }),
        context.runtimeConfig.ensureLoaded(),
      ]);
      authStatus = status;
    } catch {
      // The dialog still reopens; only its provider name may be missing.
    }
    const current = page.getScope();
    if (
      runner.state.phase !== "idle" ||
      current.context.gateway.snapshot.client !== client ||
      current.agentId !== agentId ||
      !page.canContinue()
    ) {
      // The record stays; the next connection or config change tries again.
      return;
    }
    const allowSetup = recovery.selectModel ?? host.allowSetup();
    const selected = host
      .loginProviders(undefined, authStatus, allowSetup)
      .flatMap((group) => group.choices)
      .find((choice) => choice.id === recovery.authChoice);
    if (selected) {
      adopt(selected, allowSetup);
    }
    own(scope);
    record = receipt;
    runner.restore(recovery, observe(receipt), "models.authLogin", {
      label: selected?.label,
      brandId: selected?.brandId,
    });
    resume();
  }

  return {
    onStart,
    synchronize,
    reopen,
    /** Starts the chosen sign-in. */
    choose(selected: LoginChoice, allowSetup: boolean): void {
      adopt(selected, allowSetup);
      lastSignIn?.restart();
    },
    restart: () => lastSignIn?.restart(),
    get mode() {
      return mode;
    },
    set mode(next: "auth" | "activate" | "access") {
      mode = next;
    },
    get authProviderId() {
      return authProviderId;
    },
    get authProviderLabel() {
      return authProviderLabel;
    },
    /** A running sign-in its owner can still resume survives a connection or agent change. */
    get active(): boolean {
      return owner !== undefined && runner.hasAdmittedSession;
    },
    forget(): void {
      owner = undefined;
      mode = "auth";
      authProviderId = undefined;
      authProviderLabel = undefined;
    },
  };
}
