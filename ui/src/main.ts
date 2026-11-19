import "./styles.css";
import "./styles/settings-native-controls.css";
import "./styles/checkbox.css";
import { unsupportedControlUiBrowser } from "./app/boot-capabilities.ts";
import { prepareApplicationStartup } from "./app/bootstrap-connection.ts";
import { initializeControlUiDocumentHead } from "./app/control-ui-document-head.ts";
import { startEarlyApplicationGateway } from "./app/early-gateway.ts";
import { openClawIdDocumentConfig } from "./app/openclaw-id-document.ts";
import { OPENCLAW_ID_CALLBACK_PATH } from "./lib/openclaw-id/callback-contract.ts";

// The OpenClaw ID sign-in popup returns to the SPA document; it only hands the
// code back to the tab that opened it and never starts the application.
const openclawIdDocument = openClawIdDocumentConfig();
if (
  openclawIdDocument &&
  window.location.pathname.replace(/\/+$/, "") ===
    `${openclawIdDocument.basePath.replace(/\/+$/, "")}${OPENCLAW_ID_CALLBACK_PATH}`
) {
  void import("./lib/openclaw-id/sign-in-callback.ts").then((callback) =>
    callback.finishOpenClawIdCallback(),
  );
} else if (!unsupportedControlUiBrowser) {
  const initial = prepareApplicationStartup();
  initializeControlUiDocumentHead();
  const early = startEarlyApplicationGateway(initial);
  // Keep transport first; the scoped read and validation overlap the application graph.
  initial.prewarmChatSnapshot();
  // Only cold session history waits for connect dispatch; Template authentication
  // and the application import start independently, even on an unreachable Gateway.
  void Promise.resolve(early?.beforeRuntime)
    .then(() => import("./main.runtime.ts"))
    .then(({ startControlUi }) => startControlUi(initial, early));
}
