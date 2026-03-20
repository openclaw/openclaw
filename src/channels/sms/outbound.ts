import type { NodeRegistry } from "../../gateway/node-registry.js";
import type { OutboundSendDeps } from "../../infra/outbound/deliver.js";

let smsNodeRegistry: NodeRegistry | null = null;

/**
 * Called by the gateway server to wire the node registry into the SMS outbound
 * adapter so it can invoke `sms.send` on connected Android nodes.
 */
export function setSmsNodeRegistry(registry: NodeRegistry | null) {
  smsNodeRegistry = registry;
}

function findAndroidNodeWithSms(registry: NodeRegistry): { nodeId: string } | null {
  const connected = registry.listConnected();
  for (const node of connected) {
    const isAndroid =
      node.platform?.toLowerCase().startsWith("android") ||
      node.deviceFamily?.toLowerCase().includes("android");
    if (isAndroid && node.commands?.includes("sms.send")) {
      return { nodeId: node.nodeId };
    }
  }
  return null;
}

export async function sendSmsViaNode(params: {
  to: string;
  text: string;
  nodeId?: string | null;
  deps?: OutboundSendDeps | null;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const registry = smsNodeRegistry;
  if (!registry) {
    return { ok: false, error: "SMS gateway not initialized" };
  }

  // Prefer the specific node that received the inbound SMS (passed via accountId),
  // falling back to any connected Android node with SMS capability.
  let targetNodeId = params.nodeId?.trim() || null;
  if (targetNodeId && !registry.get(targetNodeId)) {
    targetNodeId = null; // node disconnected, fall back
  }
  const node = targetNodeId ? { nodeId: targetNodeId } : findAndroidNodeWithSms(registry);
  if (!node) {
    return { ok: false, error: "No Android node with SMS capability connected" };
  }

  const result = await registry.invoke({
    nodeId: node.nodeId,
    command: "sms.send",
    params: { to: params.to, message: params.text },
    timeoutMs: 30_000,
  });

  if (!result.ok) {
    const errorMsg = result.error?.message ?? "sms.send failed";
    return { ok: false, error: errorMsg };
  }

  return {
    ok: true,
    messageId: `sms-${Date.now()}`,
  };
}
