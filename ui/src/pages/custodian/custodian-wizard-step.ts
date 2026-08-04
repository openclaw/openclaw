import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import type { WizardAnswer } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import type { WizardStepPresentation } from "../../components/wizard-step-controls.ts";
import { t } from "../../i18n/index.ts";
import type { CustodianSendOutcome } from "./event-nudge.ts";
import type { CustodianMessage } from "./transcript.ts";

type CustodianWizardSubmission = {
  answer: WizardAnswer;
  display: string;
};

const SYSTEM_AGENT_QR_POLL_INTERVAL_MS = 1_000;

export class CustodianQrScheduler {
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private stepId: string | null = null;

  constructor(
    private readonly callbacks: {
      onExpire: (stepId: string, notify: boolean) => void;
      onPoll: (client: GatewayBrowserClient, stepId: string) => void;
    },
  ) {}

  clear(): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.stepId = null;
  }

  beginAcknowledgement(
    client: GatewayBrowserClient,
    stepId: string,
    isCurrent: () => boolean,
  ): (outcome: CustodianSendOutcome) => void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    let delivered = false;
    return (outcome) => {
      if (!isCurrent()) {
        return;
      }
      if (outcome !== "rejected" && !delivered) {
        delivered = true;
        if (this.stepId === stepId) {
          this.clear();
        }
        this.callbacks.onExpire(stepId, true);
      }
      if (outcome !== "sent") {
        this.schedulePoll(client, stepId);
      }
    };
  }

  scheduleStep(client: GatewayBrowserClient, step: WizardStep): void {
    this.clear();
    if (step.type !== "qr") {
      return;
    }
    this.stepId = step.id;
    const expiresInMs = step.expiresInMs;
    if (typeof expiresInMs === "number" && Number.isFinite(expiresInMs)) {
      if (expiresInMs <= 0) {
        this.callbacks.onExpire(step.id, false);
      } else {
        this.expiryTimer = setTimeout(
          () => {
            this.expiryTimer = null;
            this.callbacks.onExpire(step.id, true);
          },
          resolveSafeTimeoutDelayMs(expiresInMs, { minMs: 0 }),
        );
      }
    }
    this.schedulePoll(client, step.id);
  }

  schedulePoll(client: GatewayBrowserClient, stepId: string): void {
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
    }
    this.stepId = stepId;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.callbacks.onPoll(client, stepId);
    }, SYSTEM_AGENT_QR_POLL_INTERVAL_MS);
  }
}

export function scrubCustodianQrSteps(
  messages: readonly CustodianMessage[],
  stepId?: string,
): CustodianMessage[] {
  return messages.map((message) => {
    const step = message.step;
    if (step?.type !== "qr" || (stepId !== undefined && step.id !== stepId)) {
      return message;
    }
    const { qrDataUrl: _qrDataUrl, ...scrubbedStep } = step;
    return { ...message, step: { ...scrubbedStep, expiresInMs: 0 } };
  });
}

export function replaceCustodianQrStep(
  messages: readonly CustodianMessage[],
  step: WizardStep,
): CustodianMessage[] {
  return messages.map((message) => (message.step?.id === step.id ? { ...message, step } : message));
}

export function findCustodianQrStep(
  messages: readonly CustodianMessage[],
  stepId: string,
): WizardStepPresentation | null {
  return (
    messages.findLast((message) => message.step?.type === "qr" && message.step.id === stepId)
      ?.step ?? null
  );
}

function findOption(step: WizardStepPresentation, value: unknown) {
  return step.options?.find((option) => Object.is(option.value, value));
}

/** Build the typed answer sent by a client rendering the current wizard step. */
export function custodianWizardSubmission(
  step: WizardStepPresentation,
  value: unknown,
): CustodianWizardSubmission | null {
  if (step.type === "note" || step.type === "action" || step.type === "progress") {
    return {
      answer: { stepId: step.id },
      display: t("common.continue"),
    };
  }
  if (step.type === "qr") {
    const confirmed = value !== false;
    return {
      answer: { stepId: step.id, value: confirmed },
      display: t(confirmed ? "common.continue" : "common.cancel"),
    };
  }
  if (step.type === "text") {
    return typeof value === "string"
      ? { answer: { stepId: step.id, value }, display: value }
      : null;
  }
  if (step.type === "confirm") {
    if (typeof value !== "boolean") {
      return null;
    }
    return {
      answer: { stepId: step.id, value },
      display: t(value ? "common.yes" : "common.no"),
    };
  }
  if (step.type === "select") {
    const option = findOption(step, value);
    return option ? { answer: { stepId: step.id, value }, display: option.label } : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  if (value.length === 0) {
    return { answer: { stepId: step.id, value: [] }, display: t("common.none") };
  }
  const labels = value.map((entry) => findOption(step, entry)?.label);
  if (!labels.every((label): label is string => label !== undefined)) {
    return null;
  }
  return {
    answer: { stepId: step.id, value },
    display: labels.join(", "),
  };
}

export function initialCustodianWizardValue(step: WizardStepPresentation): unknown {
  return step.type === "multiselect"
    ? Array.isArray(step.initialValue)
      ? [...step.initialValue]
      : []
    : step.initialValue;
}
