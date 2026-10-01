import { callGateway } from "../../../gateway/call.js";

export async function refreshGatewayAuthStateAfterAuthProfileRepair(): Promise<void> {
  for (const request of [
    { method: "secrets.reload", params: {} },
    { method: "models.authStatus", params: { refresh: true } },
  ]) {
    try {
      await callGateway({ ...request, timeoutMs: 3000 });
    } catch {
      // Doctor repair remains best effort when the Gateway is stopped or cannot reload.
    }
  }
}
