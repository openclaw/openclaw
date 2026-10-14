import type { WizardAnswer } from "@openclaw/gateway-protocol";
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import type { WizardStep } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayCapabilityAdvertised } from "../../lib/gateway-methods.ts";

type CustodianWizardSubmission = {
  answer: WizardAnswer;
  display: string;
};

/** Build the typed answer sent by a client rendering the current wizard step. */
export function custodianWizardSubmission(
  step: WizardStep,
  value: unknown,
): CustodianWizardSubmission | null {
  if (step.type === "note" || step.type === "action" || step.type === "progress") {
    return { answer: { stepId: step.id }, display: t("common.continue") };
  }
  const answer = { stepId: step.id, value };
  if (step.type === "text") {
    return typeof value === "string" ? { answer, display: value } : null;
  }
  if (step.type === "confirm") {
    return typeof value === "boolean"
      ? { answer, display: t(value ? "common.yes" : "common.no") }
      : null;
  }
  const findOption = (optionValue: unknown) =>
    step.options?.find((option) => Object.is(option.value, optionValue));
  if (step.type === "select") {
    const option = findOption(value);
    return option ? { answer, display: option.label } : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const labels = value.map((entry) => findOption(entry)?.label);
  if (!labels.every((label): label is string => label !== undefined)) {
    return null;
  }
  return {
    answer: value.length ? answer : { ...answer, value: [] },
    display: labels.length ? labels.join(", ") : t("common.none"),
  };
}

export function isCustodianWizardCancelAvailable(context: ApplicationContext | null): boolean {
  return (
    isGatewayCapabilityAdvertised(
      context?.gateway.snapshot ?? {},
      GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
    ) ?? false
  );
}
