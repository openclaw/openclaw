import "./styles.css";
import "./styles/settings-native-controls.css";
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
  // Route hints fetch the renderer while the challenge/signature is pending.
  // Cold evaluation overlaps the reply; admitted cached views must not wait
  // for a challenge that might never arrive while the Gateway is unreachable.
  void (
    early && !early.credentials.hasWarmBoot
      ? early.transport.client.initialConnectSent
      : Promise.resolve()
  )
    .then(() => import("./main.runtime.ts"))
    .then(({ startControlUi }) => startControlUi(initial, early));
}
