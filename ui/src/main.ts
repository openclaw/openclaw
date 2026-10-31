import "./styles.css";
import "./styles/settings-native-controls.css";
import { unsupportedControlUiBrowser } from "./app/boot-capabilities.ts";
import { prepareApplicationStartup } from "./app/bootstrap-connection.ts";
import { initializeControlUiDocumentHead } from "./app/control-ui-document-head.ts";
import { startEarlyApplicationGateway } from "./app/early-gateway.ts";

if (!unsupportedControlUiBrowser) {
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
