import type {
  WizardStartResult,
  WizardStatusResult,
} from "../../../../packages/gateway-protocol/src/schema/wizard.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  ProviderLoginOption,
  SystemAgentSetupActivateParams,
  WizardNextResult,
} from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isSetupAdmissionBusyError, isWizardNotFoundError } from "../../lib/gateway-errors.ts";
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../../lib/open-external-url.ts";
import { generateUUID } from "../../lib/uuid.ts";
import type { FirstRunSetup } from "./first-run-setup.ts";
import {
  MODEL_SETUP_AUTH_START_TIMEOUT_MS,
  MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS,
  type ModelSetupWizardResult,
  type ModelSetupWizardState,
  wizardStateFromResult,
} from "./state.ts";

export type ModelSetupWizardStartMethod =
  | "models.authLogin"
  | "openclaw.setup.auth.start"
  | "openclaw.setup.prepare.start"
  | "openclaw.setup.activate.start";

export type ModelSetupWizardCompletion = {
  startMethod: ModelSetupWizardStartMethod;
  preparedModelRef?: string;
  activationTargetId?: string;
  modelActivation?: WizardNextResult["modelActivation"];
  isCurrent?: () => boolean;
};

type WizardTerminalObserver = (result: ModelSetupWizardResult) => (() => boolean) | void;

type WizardRunnerOptions = {
  getClient: () => GatewayBrowserClient | null;
  getAgentId: () => string | null;
  onChange: (state: ModelSetupWizardState) => void;
  onBackgroundCompletion?: (completion: ModelSetupWizardCompletion) => Promise<void>;
  onStart?: (
    method: ModelSetupWizardStartMethod,
    activation?: Parameters<FirstRunSetup["beginActivation"]>[0],
  ) => WizardTerminalObserver | undefined;
  requestFailedMessage: () => string;
  cancelledMessage: () => string;
  sessionExpiredMessage: () => string;
};

type WizardSession = {
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

export class ModelSetupWizardRunner {
  private currentState: ModelSetupWizardState = { phase: "idle" };
  private session: WizardSession | null = null;
  private retirementGeneration = 0;
  private authLabel: string | undefined;
  private pendingSignIn:
    | { kind: ProviderLoginOption["kind"]; window: WindowProxy | null }
    | undefined;

  constructor(private readonly options: WizardRunnerOptions) {}

  prepareSignIn(kind: ProviderLoginOption["kind"] | "install" | "custom", label: string): void {
    this.authLabel = label;
    this.pendingSignIn?.window?.close();
    const browser = kind === "oauth" || kind === "device-code";
    this.pendingSignIn = {
      kind: browser ? kind : "secret",
      window: browser ? reserveExternalWindowForDeferredNavigation() : null,
    };
  }

  get state(): ModelSetupWizardState {
    return this.currentState;
  }

  get hasAdmittedSession(): boolean {
    return this.session?.admitted === true;
  }

  suspend(): void {
    const session = this.session;
    if (!session) {
      return;
    }
    session.suspended = true;
    session.abortController.abort();
    this.setState({ phase: "starting", authChoice: session.authChoice });
  }

  async resume(): Promise<ModelSetupWizardCompletion | null> {
    const previous = this.session;
    const client = this.options.getClient();
    if (!previous?.admitted || !client) {
      return null;
    }
    // Retire the old request handle, not its Gateway-owned wizard. A reply or
    // timeout from the old transport must not cancel the resumed operation.
    previous.retired = true;
    previous.abortController.abort();
    const session: WizardSession = {
      ...previous,
      client,
      abortController: new AbortController(),
      cancellationPromise: undefined,
      inputClosurePromise: undefined,
      suspended: false,
      retired: false,
    };
    this.session = session;
    this.setState({ phase: "starting", authChoice: session.authChoice });
    try {
      if (session.terminalResult) {
        return this.applyResult(session, session.authChoice, session.terminalResult);
      }
      // Never repeat start or the last answer: either may have committed before
      // the socket closed. The existing wizard owns the next visible step.
      return await this.requestNext(session, session.authChoice);
    } catch (error) {
      this.handleError(error, session);
      return null;
    }
  }

  async start(
    authChoice: string,
    startMethod: Exclude<
      ModelSetupWizardStartMethod,
      "openclaw.setup.activate.start"
    > = "openclaw.setup.auth.start",
    preferences: Pick<SystemAgentSetupActivateParams, "nativeSessionCatalogsEnabled"> = {},
    modelTarget?: "utility",
  ): Promise<ModelSetupWizardCompletion | null> {
    return this.startSession(authChoice, startMethod, {
      authChoice,
      ...preferences,
      ...(modelTarget ? { modelTarget } : {}),
    });
  }

  activate(
    params: SystemAgentSetupActivateParams,
    targetId: string,
  ): Promise<ModelSetupWizardCompletion | null> {
    return this.startSession(
      params.authChoice ?? params.kind,
      "openclaw.setup.activate.start",
      params,
      targetId,
    );
  }

  private async startSession(
    authChoice: string,
    startMethod: ModelSetupWizardStartMethod,
    params: { authChoice: string; modelTarget?: "utility" } | SystemAgentSetupActivateParams,
    activationTargetId?: string,
  ): Promise<ModelSetupWizardCompletion | null> {
    const client = this.options.getClient();
    if (!client || this.currentState.phase !== "idle") {
      return null;
    }
    const session: WizardSession = {
      client,
      sessionId: generateUUID(),
      retirementGeneration: this.retirementGeneration,
      authChoice,
      authKind: this.pendingSignIn?.kind,
      notes: [],
      reservedWindow: this.pendingSignIn?.window,
      abortController: new AbortController(),
      startMethod,
      activationTargetId,
      onTerminalResult: this.options.onStart?.(
        startMethod,
        "kind" in params
          ? params
          : startMethod === "openclaw.setup.auth.start"
            ? { ...params, kind: "provider-auth" }
            : undefined,
      ),
    };
    this.pendingSignIn = undefined;
    this.session = session;
    this.setState({ phase: "starting", authChoice });
    try {
      const agentId = this.options.getAgentId();
      const request = client
        .request<WizardStartResult>(
          startMethod,
          {
            sessionId: session.sessionId,
            ...params,
            ...(agentId ? { agentId } : {}),
          },
          { timeoutMs: null },
        )
        .catch((error: unknown): ModelSetupWizardResult => {
          if (!isSetupAdmissionBusyError(error)) {
            throw error;
          }
          // Normalize only the retained start's proven non-admission, including
          // late replies after deadline/disposal, through exact terminal cleanup.
          return {
            done: true,
            status: "not-admitted",
            error: formatUiError(error, this.options.requestFailedMessage()),
          };
        });
      const started = await this.awaitWizardStart(session, request);
      if (!started.done) {
        session.admitted = true;
      }
      if (session !== this.session && !started.done) {
        // Admission can finish after cancellation; release only its original session.
        await this.cancelSession(session);
        return null;
      }
      if (started.done) {
        return this.applyResult(session, authChoice, started);
      }
      return await this.requestNext(session, authChoice);
    } catch (error) {
      this.handleError(error, session);
      return null;
    }
  }

  async answer(value: unknown, includeValue = true): Promise<ModelSetupWizardCompletion | null> {
    const state = this.currentState;
    const session = this.session;
    if (state.phase !== "step" || state.busy || !session) {
      return null;
    }
    this.setState({ ...state, busy: true, validationError: null });
    const answer = includeValue ? { stepId: state.step.id, value } : { stepId: state.step.id };
    try {
      return await this.requestNext(session, state.authChoice, answer);
    } catch (error) {
      const pending = session.externalInputRequest;
      if (pending) {
        session.externalInputRequest = undefined;
        const completion = await pending;
        if (completion || session !== this.session) {
          return completion;
        }
      }
      this.handleError(error, session);
      return null;
    }
  }

  async cancel(options: { settleActiveRequest?: boolean } = {}): Promise<void> {
    this.pendingSignIn?.window?.close();
    this.pendingSignIn = undefined;
    const session = this.session;
    session?.reservedWindow?.close();
    clearTimeout(session?.externalInputTimer);
    if (!options.settleActiveRequest) {
      session?.abortController.abort();
    }
    this.session = null;
    this.authLabel = undefined;
    this.setState({ phase: "idle" });
    if (session) {
      await this.cancelSession(session);
    }
  }

  async requestCancellation(): Promise<"cancelled" | "running" | undefined> {
    const session = this.session;
    if (!session) {
      this.close();
      return "cancelled";
    }
    session.cancellationRequested = true;
    let result: WizardStatusResult | undefined;
    try {
      result = await this.sendCancellation(session);
    } catch (error) {
      if (session !== this.session || this.isRetired(session) || session.suspended) {
        return undefined;
      }
      if (isWizardNotFoundError(error)) {
        this.handleError(error, session);
        return undefined;
      }
      throw error;
    }
    if (session !== this.session || this.isRetired(session) || session.suspended) {
      return undefined;
    }
    if (result?.status === "cancelled" || result?.status === "error") {
      if (session.startMethod === "models.authLogin") {
        // Cancellation acknowledges the abort before provider teardown releases
        // admission. Status waits for that release; a purged session is settled.
        try {
          await session.client.request<WizardStatusResult>(
            "wizard.status",
            { sessionId: session.sessionId },
            {
              timeoutMs: MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS,
              signal: session.abortController.signal,
            },
          );
        } catch (error) {
          if (!isWizardNotFoundError(error)) {
            throw error;
          }
        }
        if (session !== this.session || this.isRetired(session) || session.suspended) {
          return undefined;
        }
      }
      this.close();
      return "cancelled";
    }
    // Protected preparation may decline cancellation. Keep the admitted wizard
    // and its outstanding next request so the same auth flow can reach a checkpoint.
    if (result?.status === "running") {
      session.cancellationRequested = false;
      return "running";
    }
    return undefined;
  }

  close(options: { retireOwner?: boolean } = {}): void {
    // Only owner loss retires detached cleanup. Ordinary close still lets a
    // late same-owner admission be cancelled and its exact receipt be cleared.
    if (options.retireOwner) {
      this.retirementGeneration += 1;
    }
    this.pendingSignIn?.window?.close();
    this.pendingSignIn = undefined;
    this.session?.reservedWindow?.close();
    clearTimeout(this.session?.externalInputTimer);
    this.session?.abortController.abort();
    this.session = null;
    this.authLabel = undefined;
    this.setState({ phase: "idle" });
  }

  fail(message: string): void {
    const label = this.authLabel;
    this.close();
    this.authLabel = label;
    this.setState({ phase: "error", message });
  }

  private async awaitWizardStart(
    session: WizardSession,
    request: Promise<ModelSetupWizardResult>,
  ): Promise<ModelSetupWizardResult> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Gateway request abort/deadline retirement discards the late session needed for cleanup.
    const retainedRequest = request.then(async (result) => {
      if (timedOut) {
        if (result.done) {
          this.reportTerminalResult(session, result);
        } else {
          await this.cancelSession(session);
        }
      }
      return result;
    });
    try {
      return await Promise.race([
        retainedRequest,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `gateway request timed out after ${MODEL_SETUP_AUTH_START_TIMEOUT_MS}ms: ${session.startMethod}`,
              ),
            );
          }, MODEL_SETUP_AUTH_START_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestNext(
    session: WizardSession,
    authChoice: string,
    answer?: { stepId: string; value?: unknown },
    acceptResult?: () => boolean,
  ): Promise<ModelSetupWizardCompletion | null> {
    if (session.suspended || this.isRetired(session)) {
      return null;
    }
    const { client, sessionId, abortController } = session;
    const signal = abortController.signal;
    let nextAnswer = answer;
    let acceptsFirstResult = acceptResult;
    while (true) {
      const result = await client.request<WizardNextResult>(
        "wizard.next",
        { sessionId, ...(nextAnswer ? { answer: nextAnswer } : {}) },
        { timeoutMs: MODEL_SETUP_WIZARD_NEXT_TIMEOUT_MS, signal },
      );
      if (acceptsFirstResult && !acceptsFirstResult() && !result.done) {
        return null;
      }
      acceptsFirstResult = undefined;
      if (
        session === this.session &&
        !result.done &&
        result.step?.type === "note" &&
        (session.authKind === "oauth" || session.authKind === "device-code")
      ) {
        if (result.step.message) {
          session.notes.push(result.step.message);
        }
        this.openSignInUrl(session, result.step.externalUrl);
        nextAnswer = { stepId: result.step.id };
        continue;
      }
      const completion = this.applyResult(session, authChoice, result);
      if (session !== this.session || completion) {
        return completion;
      }
      const next = this.currentState;
      if (next.phase !== "step" || next.step.executor !== "gateway") {
        return null;
      }
      // Gateway-owned progress has no user control to trigger the next poll.
      // Keep it in this request chain so its mutation owner settles with it.
      nextAnswer = undefined;
    }
  }

  private applyResult(
    session: WizardSession,
    authChoice: string,
    result: ModelSetupWizardResult,
  ): ModelSetupWizardCompletion | null {
    if (session === this.session && session.suspended && result.done) {
      session.terminalResult = result;
      return null;
    }
    const isCurrent = this.reportTerminalResult(session, result);
    if (session !== this.session || session.suspended) {
      return null;
    }
    if (isCurrent?.() === false) {
      this.close();
      return null;
    }
    if (result.done && result.status === "cancelled" && session.cancellationRequested) {
      this.close();
      return null;
    }
    let next = wizardStateFromResult(
      authChoice,
      result,
      result.status === "cancelled"
        ? this.options.cancelledMessage()
        : this.options.requestFailedMessage(),
    );
    if (
      next.phase === "step" &&
      session.authKind === "oauth" &&
      next.step.type === "text" &&
      next.step.externalUrl
    ) {
      next = { ...next, externalAuthInput: true };
    }
    if (session.notes.length) {
      if (next.phase === "error") {
        next = { ...next, message: [next.message, ...session.notes].join("\n\n") };
      } else if (
        next.phase === "step" &&
        next.step.executor !== "gateway" &&
        !next.step.externalUrl
      ) {
        next = {
          ...next,
          step: {
            ...next.step,
            message: [next.step.message, ...session.notes].filter(Boolean).join("\n\n"),
          },
        };
      }
    }
    clearTimeout(session.externalInputTimer);
    if (result.done) {
      session.reservedWindow?.close();
      this.session = null;
    }
    this.setState(next);
    if (next.phase === "step") {
      this.openSignInUrl(session, next.step.externalUrl);
      if (next.externalAuthInput) {
        this.watchExternalInput(session, next);
      } else if (next.step.executor !== "gateway") {
        session.reservedWindow?.close();
        session.reservedWindow = null;
      }
    }
    if (!result.done || result.status !== "done") {
      return null;
    }
    return {
      startMethod: session.startMethod,
      ...(session.activationTargetId ? { activationTargetId: session.activationTargetId } : {}),
      ...(isCurrent ? { isCurrent } : {}),
      ...(result.preparedModelRef ? { preparedModelRef: result.preparedModelRef } : {}),
      ...(result.modelActivation ? { modelActivation: result.modelActivation } : {}),
    };
  }

  private openSignInUrl(session: WizardSession, url: string | undefined): void {
    if (!url || session.openedUrl === url) {
      return;
    }
    const safeUrl = resolveSafeExternalUrl(url, window.location.href);
    if (!safeUrl) {
      return;
    }
    if (session.reservedWindow && !session.reservedWindow.closed) {
      session.reservedWindow.location.replace(safeUrl);
      session.reservedWindow = null;
    } else {
      openExternalUrlSafe(safeUrl);
    }
    session.openedUrl = url;
  }

  private watchExternalInput(session: WizardSession, state: ModelSetupWizardState): void {
    // Only the browser callback can settle this input without an answer. One
    // wizard read per second stops as soon as this exact presentation changes.
    const poll = async () => {
      const current = () =>
        session === this.session && this.currentState === state && !session.suspended;
      if (!current()) {
        return;
      }
      try {
        const request = this.requestNext(session, session.authChoice, undefined, current);
        session.externalInputRequest = request;
        const completion = await request;
        if (session.externalInputRequest !== request) {
          return;
        }
        session.externalInputRequest = undefined;
        if (completion) {
          const completedState = this.currentState;
          const isCurrent = completion.isCurrent;
          await this.options.onBackgroundCompletion?.({
            ...completion,
            isCurrent: () => this.currentState === completedState && isCurrent?.() !== false,
          });
        }
      } catch (error) {
        if (current()) {
          this.handleError(error, session);
        }
      }
    };
    session.externalInputTimer = setTimeout(() => {
      void poll();
    }, 1000);
  }

  private handleError(error: unknown, session: WizardSession): void {
    if (session !== this.session || session.suspended) {
      return;
    }
    clearTimeout(session.externalInputTimer);
    session.reservedWindow?.close();
    this.session = null;
    session.abortController.abort();
    const sessionExpired = isWizardNotFoundError(error);
    if (!sessionExpired) {
      void this.cancelSession(session);
    }
    const message = sessionExpired
      ? this.options.sessionExpiredMessage()
      : formatUiError(error, this.options.requestFailedMessage());
    this.setState({ phase: "error", message: [message, ...session.notes].join("\n\n") });
  }

  private async cancelSession(session: WizardSession): Promise<WizardStatusResult | undefined> {
    try {
      return await this.sendCancellation(session, session.startMethod === "models.authLogin");
    } catch {
      // Detached cleanup is best effort; explicit cancellation surfaces failures.
      return undefined;
    }
  }

  private async sendCancellation(
    session: WizardSession,
    closeInput = false,
  ): Promise<WizardStatusResult | undefined> {
    if (this.isRetired(session)) {
      return undefined;
    }
    const promiseKey = closeInput ? "inputClosurePromise" : "cancellationPromise";
    if (!session[promiseKey]) {
      // Disposal must close input even when a pending user cancellation can
      // still return running for a protected credential write.
      session[promiseKey] = session.client
        .request<WizardStatusResult>(
          "wizard.cancel",
          { sessionId: session.sessionId, ...(closeInput ? { closeInput: true } : {}) },
          { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
        )
        .then((result) => {
          if (result.status === "cancelled" || result.status === "error") {
            this.reportTerminalResult(session, { done: true, ...result });
          }
          return result;
        })
        .finally(() => {
          session[promiseKey] = undefined;
        });
    }
    return session[promiseKey];
  }

  private reportTerminalResult(
    session: WizardSession,
    result: ModelSetupWizardResult,
  ): (() => boolean) | void {
    // Confirmed failure/cancellation owns exact receipt cleanup after presentation retires.
    // Success and visible state still require this runner's live session.
    if (this.isRetired(session) || session.suspended) {
      return;
    }
    const failed =
      result.status === "cancelled" ||
      result.status === "error" ||
      result.status === "not-admitted";
    if (result.done && (session === this.session || failed)) {
      return session.onTerminalResult?.(result);
    }
  }

  private isRetired(session: WizardSession): boolean {
    return session.retired === true || session.retirementGeneration !== this.retirementGeneration;
  }

  private setState(state: ModelSetupWizardState): void {
    clearTimeout(this.session?.externalInputTimer);
    if (this.authLabel) {
      state.authLabel = this.authLabel;
    }
    this.currentState = state;
    this.options.onChange(state);
  }
}
