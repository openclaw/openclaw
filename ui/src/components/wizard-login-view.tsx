import { createMemo } from "solid-js";
import { ModelSetupWizard, type WizardViewProps } from "../pages/model-setup/wizard-view-solid.tsx";
import "../styles/model-setup.css";
import type { WizardLoginState } from "./wizard-login-controller.tsx";

export function WizardLogin(props: {
  controller: WizardLoginState;
  busy?: boolean;
  options?: Parameters<WizardLoginState["viewProps"]>[0];
  signInIcon?: WizardViewProps["signInIcon"];
}) {
  const view = createMemo(() => props.controller.viewProps(props.options));
  return (
    <div onModal-cancel={(event: Event) => event.preventDefault()}>
      <ModelSetupWizard {...view()} busy={props.busy} signInIcon={props.signInIcon} />
    </div>
  );
}
