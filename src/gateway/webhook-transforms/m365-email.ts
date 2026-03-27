export type M365EmailTransformResult = {
  message: string;
  name: string;
  sessionKey: string;
} | null;

/**
 * Transforms Microsoft 365 email change notification webhook into an agent message.
 *
 * M365 Graph API sends notifications when emails arrive in a monitored mailbox:
 * {
 *   "value": [{
 *     "subscriptionId": "guid",
 *     "clientState": "state-string",
 *     "changeType": "created",
 *     "resource": "users/{email}/messages/{message-id}",
 *     "resourceData": {
 *       "@odata.type": "#Microsoft.Graph.Message",
 *       "@odata.id": "users/{email}/messages/{message-id}"
 *     }
 *   }]
 * }
 *
 * Note: The Graph API validation handshake (?validationToken=...) is handled
 * by the HTTP layer before this transform is called.
 */
export function transformM365EmailPayload(
  payload: Record<string, unknown>,
): M365EmailTransformResult {
  const notifications = Array.isArray(payload.value) ? payload.value : [];
  if (notifications.length === 0) {
    return null;
  }

  const notification = notifications[0] as Record<string, unknown>;
  const resource = typeof notification.resource === "string" ? notification.resource : "";
  const changeType =
    typeof notification.changeType === "string" ? notification.changeType : "unknown";
  const clientState = typeof notification.clientState === "string" ? notification.clientState : "";

  // Extract message ID from resource path: users/{email}/messages/{id}
  const messageIdMatch = resource.match(/messages\/([^/]+)$/);
  const messageId = messageIdMatch ? messageIdMatch[1] : null;
  if (!messageId) {
    return null;
  }

  // Extract mailbox address from resource path
  const emailMatch = resource.match(/users\/([^/]+)\//);
  const mailbox = emailMatch ? emailMatch[1] : "unknown";

  const lines: string[] = [];
  lines.push(`## M365: New Email Received`);
  lines.push(`**Mailbox:** ${mailbox}`);
  lines.push(`**Message ID:** ${messageId}`);
  lines.push(`**Change Type:** ${changeType}`);
  if (clientState) {
    lines.push(`**Client State:** ${clientState}`);
  }
  lines.push("");
  lines.push("**Next Steps:**");
  lines.push("1. Fetch full email content from Graph API using the message ID");
  lines.push("2. Parse sender, subject, and body");
  lines.push("3. Determine appropriate action (reply, forward, execute task)");

  return {
    message: lines.join("\n").trim(),
    name: `M365 Email: ${mailbox}`,
    sessionKey: `webhook:m365-email:${messageId}`,
  };
}
