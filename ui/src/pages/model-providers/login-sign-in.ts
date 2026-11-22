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
 * activation record lets a reloaded page reopen the same session.
 */
export function createLoginSignIn(
  page: { getScope: () => LoginScope; canContinue: () => boolean },
  host: {
    runner: ModelSetupWizardRunner;
    run: (task: () => Promise<ModelSetupWizardCompletion | null>) => Promise<void>;
    /** Retires the request chain of a closed socket; the Gateway keeps the sign-in. */
    retireRequests: () => void;
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
  // The last started sign-in, so a typed failure can offer to start it again.
  let restart: (() => void) | undefined;
  // Who started the running sign-in. Only the same owner resumes it after a reconnect.
  let owner: { recoveryScope: string | null; agentId: string | null } | undefined;
  let restoreChecked = false;

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
    // Browser and device sign-ins can select a model; a pasted secret only saves. A
    // credential-only sign-in still succeeds when its account offers no usable model.
    const selectingModel = allowSetup && kind !== "secret";
    mode = selected.requiresSetup ? (selectingModel ? "activate" : "access") : "auth";
    const { id, label, brandId } = selected;
    restart = () => {
      runner.prepareSignIn(kind, label, brandId);
      void host.run(() =>
        runner.start(id, "models.authLogin", selectingModel ? { selectModel: true } : {}),
      );
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
    const receipt = persistFirstRunActivationReceipt(receiptContext(scope), {
      kind: intent.kind,
      wizard: intent.wizard,
    });
    return observe(receipt);
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
        host.retireRequests();
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
      void host.run(() => runner.resume());
    }
  }

  /** A sign-in recorded before a reload reopens once this page can continue it. */
  function reopen(): void {
    // Pages without a Models sign-in record never read scope: that read can load config.
    if (
      restoreChecked ||
      runner.hasAdmittedSession ||
      !hasFirstRunActivationReceipt("provider-login")
    ) {
      return;
    }
    const { context, agentId } = page.getScope();
    if (context.gateway.snapshot.phase === "connected" && agentId) {
      void restore();
    }
  }

  async function restore(): Promise<void> {
    restoreChecked = true;
    const scope = page.getScope();
    const { context, agentId } = scope;
    const client = context.gateway.snapshot.client;
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
      return;
    }
    const allowSetup = host.allowSetup();
    const selected = host
      .loginProviders(undefined, authStatus, allowSetup)
      .flatMap((group) => group.choices)
      .find((choice) => choice.id === recovery.authChoice);
    if (selected) {
      adopt(selected, allowSetup);
    }
    own(scope);
    runner.restore(recovery, observe(receipt), "models.authLogin", {
      label: selected?.label,
      brandId: selected?.brandId,
    });
    void host.run(() => runner.resume());
  }

  return {
    onStart,
    synchronize,
    reopen,
    /** Starts the chosen sign-in. */
    choose(selected: LoginChoice, allowSetup: boolean): void {
      adopt(selected, allowSetup);
      restart?.();
    },
    restart: () => restart?.(),
    get mode() {
      return mode;
    },
    set mode(next: "auth" | "activate" | "access") {
      mode = next;
    },
    get authProviderId() {
      return authProviderId;
    },
    /** A running sign-in its owner can still resume survives a connection or agent change. */
    get active(): boolean {
      return owner !== undefined && runner.hasAdmittedSession;
    },
    forget(): void {
      owner = undefined;
      mode = "auth";
      authProviderId = undefined;
    },
  };
}
