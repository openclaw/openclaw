import {
  CONTROL_UI_BASE_PATH_ATTRIBUTE,
  CONTROL_UI_ID_LABS_ATTRIBUTE,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";

/** Read public document policy before startup, without requiring private bootstrap or a fetch. */
export function openClawIdDocumentConfig(): { basePath: string } | null {
  const root = document.documentElement;
  const basePath = root.getAttribute(CONTROL_UI_BASE_PATH_ATTRIBUTE);
  return root.getAttribute(CONTROL_UI_ID_LABS_ATTRIBUTE) === "true" && basePath !== null
    ? { basePath }
    : null;
}
