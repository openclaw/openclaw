import { solidContent } from "../../lit/solid-content.tsx";
import { ModelSetupWizard, type WizardViewProps } from "./wizard-view-solid.tsx";

export type { WizardViewProps } from "./wizard-view-solid.tsx";

/** Unported wizard hosts share the Solid renderer through the retained-content boundary. */
export function renderModelSetupWizard(props: WizardViewProps) {
  return solidContent(ModelSetupWizard, props);
}
