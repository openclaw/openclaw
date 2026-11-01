import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  type ControlUiBootstrapConfig,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";

/** Read the serving Gateway's opt-in before startup; unknown policy is off. */
export function openClawIdDocumentConfig(): ControlUiBootstrapConfig | null {
  const raw = document.documentElement.getAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  if (!raw) {
    return null;
  }
  try {
    const config: ControlUiBootstrapConfig = JSON.parse(raw);
    return config.openclawIdEnabled === true ? config : null;
  } catch {
    return null;
  }
}
