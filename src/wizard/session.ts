// Wizard session helpers track onboarding session ids and state.
import { randomUUID } from "node:crypto";
import type { WizardStep as ProtocolWizardStep } from "../../packages/gateway-protocol/src/index.js";
import { QR_PNG_DATA_URL_MAX_LENGTH } from "../../packages/gateway-protocol/src/schema/qr.js";
import { renderQrPngDataUrlWithinLimit } from "../media/qr-image.js";
import { createDeferred, type Deferred } from "../shared/deferred.js";
import {
  WizardCancelledError,
  type WizardProgress,
  type WizardPrompter,
  type WizardQrCodeParams,
} from "./prompts.js";

type ProtocolWizardQrStep = Extract<ProtocolWizardStep, { type: "qr" }>;
type ProtocolWizardNonQrStep = Exclude<ProtocolWizardStep, ProtocolWizardQrStep>;

// WizardSession owns absolute deadlines and may scrub QR bytes before dropping
// its final reference. Client projection restores the required wire fields.
type WizardQrStep = Omit<ProtocolWizardQrStep, "qrDataUrl" | "expiresInMs"> & {
  qrDataUrl?: string;
  /** Internal owner deadline; client projections receive a relative `expiresInMs`. */
  qrExpiresAtMs?: number;
};
export type WizardStep = ProtocolWizardNonQrStep | WizardQrStep;
type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, Key>>
  : never;
type WizardStepInput = DistributiveOmit<WizardStep, "id">;

type WizardStepInputRequirement = "always" | "never" | "client-executor";

const WIZARD_STEP_INPUT_REQUIREMENT_BY_TYPE = {
  note: "never",
  select: "always",
  text: "always",
  confirm: "always",
  multiselect: "always",
  progress: "never",
  action: "client-executor",
  qr: "client-executor",
} as const satisfies Record<WizardStep["type"], WizardStepInputRequirement>;

/** Whether a step needs a user answer instead of client or gateway acknowledgement. */
export function wizardStepAwaitsInput(step: {
  type: WizardStep["type"];
  executor?: "gateway" | "client";
}): boolean {
  const requirement = WIZARD_STEP_INPUT_REQUIREMENT_BY_TYPE[step.type];
  switch (requirement) {
    case "always":
      return true;
    case "never":
      return false;
    case "client-executor":
      return step.executor === "client";
  }
  const unhandledRequirement: never = requirement;
  return unhandledRequirement;
}

/** Remove server-only and secret fields before a wizard step crosses a client boundary. */
export function sanitizeWizardStepForClient(
  step: WizardStep,
  qrExpiresInMs?: number,
): ProtocolWizardStep {
  if (step.type === "qr") {
    const { qrExpiresAtMs: _qrExpiresAtMs, ...safe } = step;
    if (!safe.qrDataUrl || qrExpiresInMs === undefined) {
      throw new Error("wizard: QR projection requires image bytes and a relative expiry");
    }
    return { ...safe, qrDataUrl: safe.qrDataUrl, expiresInMs: qrExpiresInMs };
  }
  const safe = { ...step };
  if (safe.sensitive === true) {
    delete safe.initialValue;
  }
  return safe;
}

type WizardSessionStatus = "running" | "done" | "cancelled" | "error";

type WizardNextResult = {
  done: boolean;
  step?: WizardStep;
  status: WizardSessionStatus;
  error?: string;
  channels?: string[];
  accounts?: Array<{ channel: string; accountId: string }>;
  preparedModelRef?: string;
};

function normalizeTextAnswer(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

class WizardSessionPrompter implements WizardPrompter {
  readonly qrCode?: (params: WizardQrCodeParams) => Promise<boolean>;

  constructor(
    private session: WizardSession,
    supportsQrCode: boolean,
  ) {
    if (supportsQrCode) {
      this.qrCode = async (params) => {
        if (
          params.expiresAtMs !== undefined &&
          (!Number.isSafeInteger(params.expiresAtMs) || params.expiresAtMs < 0)
        ) {
          throw new RangeError("expiresAtMs must be a non-negative safe integer.");
        }
        const qrDataUrl = await renderQrPngDataUrlWithinLimit(
          params.text,
          QR_PNG_DATA_URL_MAX_LENGTH,
        );
        const step = this.createStep({
          type: "qr",
          title: params.title,
          message: params.message,
          qrDataUrl,
          ...(params.expiresAtMs !== undefined ? { qrExpiresAtMs: params.expiresAtMs } : {}),
          executor: "client",
        });
        const answer = this.session.awaitAnswer(step, undefined, params.dismissed !== undefined);
        if (params.dismissed) {
          void params.dismissed.then(
            () => this.session.dismissStep(step.id, { value: true }),
            (error: unknown) => this.session.dismissStep(step.id, { error }),
          );
        }
        const result = await answer;
        return result !== false;
      };
    }
  }

  async intro(title: string): Promise<void> {
    await this.prompt({
      type: "note",
      title,
      message: "",
      executor: "client",
    });
  }

  async outro(message: string): Promise<void> {
    await this.prompt({
      type: "note",
      title: "Done",
      message,
      executor: "client",
    });
  }

  async note(message: string, title?: string): Promise<void> {
    await this.prompt({
      type: "note",
      title,
      message,
      executor: "client",
    });
  }

  async deviceCode(params: {
    title: string;
    code: string;
    expiresInMinutes?: number;
    message?: string;
  }): Promise<void> {
    const fallbackMessage = [
      params.message ?? "Enter this one-time code on the provider's sign-in page.",
      `Code: ${params.code}`,
      ...(params.expiresInMinutes
        ? [`Code expires in ${params.expiresInMinutes} minutes. Never share it.`]
        : []),
    ].join("\n");
    await this.prompt({
      type: "note",
      title: params.title,
      message: fallbackMessage,
      deviceCode: {
        code: params.code,
        ...(params.expiresInMinutes ? { expiresInMinutes: params.expiresInMinutes } : {}),
        ...(params.message ? { message: params.message } : {}),
      },
      executor: "client",
    });
  }

  async plain(message: string): Promise<void> {
    await this.prompt({
      type: "note",
      message,
      format: "plain",
      executor: "client",
    });
  }

  async select<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValue?: T;
  }): Promise<T> {
    const res = await this.prompt({
      type: "select",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValue,
      executor: "client",
    });
    return res as T;
  }

  async multiselect<T>(params: {
    message: string;
    options: Array<{ value: T; label: string; hint?: string }>;
    initialValues?: T[];
  }): Promise<T[]> {
    const res = await this.prompt({
      type: "multiselect",
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValues,
      executor: "client",
    });
    return (Array.isArray(res) ? res : []) as T[];
  }

  async text(params: {
    message: string;
    initialValue?: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
    sensitive?: boolean;
  }): Promise<string> {
    const res = await this.session.awaitAnswer(
      this.createStep({
        type: "text",
        message: params.message,
        initialValue: params.initialValue,
        placeholder: params.placeholder,
        sensitive: params.sensitive,
        executor: "client",
      }),
      params.validate,
    );
    const value =
      res === null || res === undefined
        ? ""
        : typeof res === "string"
          ? res
          : typeof res === "number" || typeof res === "boolean" || typeof res === "bigint"
            ? String(res)
            : "";
    return value;
  }

  async confirm(params: Parameters<WizardPrompter["confirm"]>[0]): Promise<boolean> {
    const res = await this.prompt({
      type: "confirm",
      message: params.message,
      initialValue: params.initialValue,
      executor: "client",
    });
    return Boolean(res);
  }

  progress(label: string): WizardProgress {
    let stopped = false;
    this.session.pushProgress(label);
    return {
      update: (message) => {
        if (!stopped) {
          this.session.pushProgress(message);
        }
      },
      stop: (message) => {
        if (stopped) {
          return;
        }
        stopped = true;
        if (message) {
          this.session.pushProgress(message);
        }
      },
    };
  }

  async openUrl(url: string): Promise<void> {
    this.session.queueExternalUrl(url);
  }

  private async prompt(step: WizardStepInput): Promise<unknown> {
    return await this.session.awaitAnswer(this.createStep(step));
  }

  private createStep(step: WizardStepInput): WizardStep {
    // Each emitted step receives an id so remote clients can answer the exact
    // pending prompt and stale answers can be rejected. Explicit browser
    // destinations bind to the very next step regardless of its input type.
    const externalUrl = this.session.consumeExternalUrl();
    const id = randomUUID();
    return step.type === "qr"
      ? { ...step, ...(externalUrl ? { externalUrl } : {}), id }
      : { ...step, ...(externalUrl ? { externalUrl } : {}), id };
  }
}

export class WizardSession {
  private readonly abortController = new AbortController();
  private readonly expiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly runnerPromise: Promise<void>;
  private currentStep: WizardStep | null = null;
  private progressSteps: WizardStep[] = [];
  private deliveredProgressStepIds = new Set<string>();
  private dismissedStepIds = new Set<string>();
  private stepDeferred: Deferred<WizardStep | null> | null = null;
  private pendingTerminalResolution = false;
  private cancellationLocked = false;
  private qrPresentationOwned = false;
  private qrPresentationHasExternalOwner = false;
  private readonly onQrPresentationOwnerSettled: ((stepId: string) => void) | undefined;
  private settled = false;
  private pendingExternalUrl: string | undefined;
  private answerDeferred = new Map<
    string,
    {
      deferred: Deferred<unknown>;
      text: boolean;
      validate?: (value: string) => string | undefined;
    }
  >();
  private status: WizardSessionStatus = "running";
  private error: string | undefined;
  private configuredAccounts: Array<{ channel: string; accountId: string }> | undefined;
  private preparedModelRef: string | undefined;

  constructor(
    private runner: (
      prompter: WizardPrompter,
      signal: AbortSignal,
      session: WizardSession,
    ) => Promise<void>,
    options?: {
      timeoutMs?: number;
      supportsQrCode?: boolean;
      onQrPresentationOwnerSettled?: (stepId: string) => void;
    },
  ) {
    this.onQrPresentationOwnerSettled = options?.onQrPresentationOwnerSettled;
    const prompter = new WizardSessionPrompter(this, options?.supportsQrCode === true);
    if (options?.timeoutMs !== undefined) {
      this.expiryTimer = setTimeout(() => this.cancel(), options.timeoutMs);
      this.expiryTimer.unref?.();
    }
    this.runnerPromise = this.run(prompter);
  }

  async next(): Promise<WizardNextResult> {
    if (this.currentStep?.type === "qr" && this.qrPresentationHasExternalOwner) {
      // Give an already-settled owner callback one microtask to retire the QR before this poll
      // snapshots it. Otherwise a poll in the same turn can replay expired credential bytes.
      await Promise.resolve();
    }
    const progressStep = this.progressSteps.shift();
    if (progressStep) {
      this.rememberDeliveredProgressStep(progressStep.id);
      return { done: false, step: progressStep, status: this.status };
    }
    if (this.currentStep) {
      return { done: false, step: this.currentStep, status: this.status };
    }
    if (this.pendingTerminalResolution) {
      this.pendingTerminalResolution = false;
      return this.terminalResult();
    }
    if (this.status !== "running") {
      return this.terminalResult();
    }
    if (!this.stepDeferred) {
      this.stepDeferred = createDeferred();
    }
    const step = await this.stepDeferred.promise;
    if (step?.type === "qr" && this.qrPresentationHasExternalOwner) {
      // The owner may settle while the first consumer wakes; let its continuation
      // publish the next state before returning a QR that is already unusable.
      await Promise.resolve();
      if (!this.isCurrentStep(step.id)) {
        return await this.next();
      }
    }
    if (step) {
      return { done: false, step, status: this.status };
    }
    return this.terminalResult();
  }

  private terminalResult(): WizardNextResult {
    return {
      done: true,
      status: this.status,
      error: this.error,
      ...(this.configuredAccounts
        ? {
            channels: [...new Set(this.configuredAccounts.map((entry) => entry.channel))],
            accounts: this.configuredAccounts.map((entry) => ({ ...entry })),
          }
        : {}),
      ...(this.status === "done" && this.preparedModelRef
        ? { preparedModelRef: this.preparedModelRef }
        : {}),
    };
  }

  private isCurrentStep(stepId: string): boolean {
    return this.currentStep?.id === stepId;
  }

  /** Record what the channels flow actually configured (channels flow only). */
  setConfiguredAccounts(accounts: ReadonlyArray<{ channel: string; accountId: string }>) {
    this.configuredAccounts = accounts.map((entry) => ({ ...entry }));
  }

  /** Record the exact provider-owned model prepared by a setup flow. */
  setPreparedModelRef(modelRef: string) {
    this.preparedModelRef = modelRef;
  }

  async answer(stepId: string, value: unknown): Promise<string | undefined> {
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      // A remote host can retain a step after its owner dismisses it. Accept one stale
      // acknowledgement so the host can pump the already-advanced session.
      if (this.dismissedStepIds.delete(stepId)) {
        return undefined;
      }
      // Gateway-owned progress steps never block the provider run. Older
      // clients still acknowledge every rendered step, so accept that stale
      // acknowledgement while newer clients poll without an answer.
      if (this.deliveredProgressStepIds.delete(stepId)) {
        return undefined;
      }
      throw new Error("wizard: no pending step");
    }
    const normalizedValue = pending.text ? normalizeTextAnswer(value) : value;
    if (pending.text && normalizedValue === undefined) {
      return "wizard: text answer must be a scalar value";
    }
    const validationError = pending.validate?.(normalizedValue as string) ?? undefined;
    if (validationError) {
      return validationError;
    }
    this.answerDeferred.delete(stepId);
    // The host may retain the delivered step while the producer resumes. Scrub credential-bearing
    // presentation bytes before resolving the producer so acknowledgement is the lifetime boundary.
    if (this.currentStep?.qrDataUrl) {
      delete this.currentStep.qrDataUrl;
    }
    this.currentStep = null;
    pending.deferred.resolve(normalizedValue);
    return undefined;
  }

  private rememberDismissedStep(stepId: string): void {
    this.dismissedStepIds.add(stepId);
    if (this.dismissedStepIds.size <= 64) {
      return;
    }
    const oldest = this.dismissedStepIds.values().next().value;
    if (oldest) {
      this.dismissedStepIds.delete(oldest);
    }
  }

  dismissStep(stepId: string, result: { value: unknown } | { error: unknown }): boolean {
    // Owner settlement matters even after the client acknowledged the QR; the host may still
    // be enforcing the credential deadline while the runner applies the truthful owner result.
    this.onQrPresentationOwnerSettled?.(stepId);
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      return false;
    }
    this.answerDeferred.delete(stepId);
    this.rememberDismissedStep(stepId);
    if (this.currentStep?.id === stepId) {
      if (this.currentStep.qrDataUrl) {
        delete this.currentStep.qrDataUrl;
      }
      this.currentStep = null;
    }
    if ("error" in result) {
      pending.deferred.reject(result.error);
    } else {
      pending.deferred.resolve(result.value);
    }
    return true;
  }

  cancel(): boolean {
    if (this.status !== "running" || this.cancellationLocked) {
      return false;
    }
    this.status = "cancelled";
    this.error = "cancelled";
    this.abortController.abort(new WizardCancelledError());
    // The bridge may retain this same step object after delivery. Scrub credential-bearing
    // presentation bytes before releasing the producer and dropping the session-owned pointer.
    if (this.currentStep?.qrDataUrl) {
      delete this.currentStep.qrDataUrl;
    }
    this.currentStep = null;
    for (const [, pending] of this.answerDeferred) {
      // Reject all pending prompt promises so the runner can unwind through its
      // normal cancellation path.
      pending.deferred.reject(new WizardCancelledError());
    }
    this.answerDeferred.clear();
    this.progressSteps = [];
    this.deliveredProgressStepIds.clear();
    this.dismissedStepIds.clear();
    this.resolveStep(null);
    return true;
  }

  /** The underlying mutation crossed its durable commit point and must finish. */
  lockCancellation() {
    this.cancellationLocked = true;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Keep a wizard eviction-protected while its QR-owned operation is still in flight. */
  hasOwnedQrPresentation(): boolean {
    return this.qrPresentationOwned && this.status === "running" && !this.settled;
  }

  /** True when a producer promise, rather than the acknowledgement, owns QR completion. */
  hasExternalQrPresentationOwner(): boolean {
    return this.hasOwnedQrPresentation() && this.qrPresentationHasExternalOwner;
  }

  /** Retire an expired credential while its external owner finishes or rejects the operation. */
  expireOwnedQrPresentation(stepId: string): boolean {
    if (!this.hasExternalQrPresentationOwner()) {
      return false;
    }
    const pending = this.answerDeferred.get(stepId);
    if (!pending) {
      return false;
    }
    this.answerDeferred.delete(stepId);
    this.rememberDismissedStep(stepId);
    if (this.currentStep?.id === stepId) {
      if (this.currentStep.qrDataUrl) {
        delete this.currentStep.qrDataUrl;
      }
      this.currentStep = null;
    }
    // Presentation expiry is not an owner failure. Release the prompt so the runner can
    // keep awaiting the dependency-owned result without treating expiry as confirmation loss.
    pending.deferred.resolve(true);
    return true;
  }

  pushStep(step: WizardStep) {
    this.currentStep = step;
    this.resolveStep(step);
  }

  pushProgress(message: string) {
    if (this.status !== "running") {
      return;
    }
    const step: WizardStep = {
      id: randomUUID(),
      type: "progress",
      message,
      executor: "gateway",
    };
    if (this.stepDeferred) {
      this.rememberDeliveredProgressStep(step.id);
      this.resolveStep(step);
      return;
    }
    // Keep the oldest unread event and the newest snapshot. This preserves the
    // initial label while bounding bursty pull updates between client polls.
    if (this.progressSteps.length >= 2) {
      this.progressSteps[this.progressSteps.length - 1] = step;
      return;
    }
    this.progressSteps.push(step);
  }

  private rememberDeliveredProgressStep(stepId: string) {
    this.deliveredProgressStepIds.add(stepId);
    if (this.deliveredProgressStepIds.size <= 64) {
      return;
    }
    const oldest = this.deliveredProgressStepIds.values().next().value;
    if (oldest) {
      this.deliveredProgressStepIds.delete(oldest);
    }
  }

  queueExternalUrl(url: string) {
    this.pendingExternalUrl = url;
  }

  consumeExternalUrl(): string | undefined {
    const url = this.pendingExternalUrl;
    this.pendingExternalUrl = undefined;
    return url;
  }

  private async run(prompter: WizardPrompter) {
    try {
      await this.runner(prompter, this.signal, this);
      if (this.status === "running") {
        this.status = "done";
      }
    } catch (err) {
      if (this.status !== "running") {
        return;
      }
      if (err instanceof WizardCancelledError) {
        this.status = "cancelled";
        this.error = err.message;
      } else {
        this.status = "error";
        this.error = String(err);
      }
    } finally {
      this.settled = true;
      if (this.expiryTimer) {
        clearTimeout(this.expiryTimer);
      }
      this.resolveStep(null);
    }
  }

  async awaitAnswer(
    step: WizardStep,
    validate?: (value: string) => string | undefined,
    qrPresentationHasExternalOwner = false,
  ): Promise<unknown> {
    if (this.status !== "running") {
      throw new Error("wizard: session not running");
    }
    // A later interactive step proves the QR-owned operation finished. Release the
    // eviction guard there; a runner stalled between steps remains protected by its QR timer.
    this.qrPresentationOwned = Boolean(step.qrDataUrl);
    this.qrPresentationHasExternalOwner =
      this.qrPresentationOwned && qrPresentationHasExternalOwner;
    this.pushStep(step);
    const deferred = createDeferred<unknown>();
    this.answerDeferred.set(step.id, { deferred, text: step.type === "text", validate });
    return await deferred.promise;
  }

  private resolveStep(step: WizardStep | null) {
    if (!this.stepDeferred) {
      if (step === null) {
        // The runner can finish immediately after an answer before next() has
        // installed a waiter; remember that terminal state for the next poll.
        this.pendingTerminalResolution = true;
      }
      return;
    }
    const deferred = this.stepDeferred;
    this.stepDeferred = null;
    deferred.resolve(step);
  }

  getStatus(): WizardSessionStatus {
    return this.status;
  }

  /** Whether the runner has stopped and can no longer mutate setup state. */
  isSettled(): boolean {
    return this.settled;
  }

  /** Resolves after the runner can no longer mutate setup state. */
  whenSettled(): Promise<void> {
    return this.runnerPromise;
  }

  getError(): string | undefined {
    return this.error;
  }
}
