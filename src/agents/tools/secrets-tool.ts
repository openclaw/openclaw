import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  checkGrant,
  getSecret,
  getSecretDef,
  getSecretMetadata,
  listSecrets,
} from "../../secrets/index.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";

const SecretsToolSchema = Type.Object({
  action: stringEnum(["get", "request", "status", "list", "resolve"], {
    description: "Action to perform",
  }),
  name: Type.Optional(
    Type.String({ description: "Secret name (required for get/request/status/resolve)" }),
  ),
});

export function createSecretsTool(opts?: { config?: OpenClawConfig }): AnyAgentTool {
  return {
    label: "Secrets",
    name: "secrets",
    description: "Manage secrets — retrieve, request approval, check grant status",
    parameters: SecretsToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const action = readStringParam(params, "action", { required: true });
      const name = readStringParam(params, "name");

      // Validate name requirement for specific actions
      if (
        (action === "get" || action === "request" || action === "status" || action === "resolve") &&
        !name
      ) {
        throw new Error(`Secret name required for action: ${action}`);
      }

      switch (action) {
        case "get": {
          try {
            // Check security mode
            const mode = cfg.security?.credentials?.mode ?? "legacy";

            if (mode === "legacy" || mode === "yolo") {
              // BACKWARD COMPATIBLE: Return value
              const value = await getSecret(name!);
              return {
                content: [{ type: "text", text: `Secret retrieved: ${name}` }],
                details: { ok: true, name, value },
              };
            } else {
              // AGENT-BLIND MODE (balanced/strict): Return metadata only
              const metadata = await getSecretMetadata(name!);

              // Format expiry time
              let expiryText = "";
              if (metadata.expiresAt) {
                const remaining = metadata.expiresAt - Date.now();
                const mins = Math.ceil(remaining / 60000);
                const hours = Math.floor(mins / 60);
                const remainingMins = mins % 60;
                if (hours > 0) {
                  expiryText = ` (expires in ${hours}h ${remainingMins}m)`;
                } else {
                  expiryText = ` (expires in ${mins}m)`;
                }
              }

              // Build description text
              const lines = [`✅ Secret available: ${name}${expiryText}`];
              if (metadata.type) {
                lines.push(`Type: ${metadata.type}`);
              }
              if (metadata.hint) {
                lines.push(`Hint: ${metadata.hint}`);
              }
              if (metadata.capabilities && metadata.capabilities.length > 0) {
                lines.push(`Capabilities: ${metadata.capabilities.join(", ")}`);
              }
              lines.push(`Reference: ${metadata.ref}`);

              return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { ok: true, ...metadata },
              };
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("No valid grant")) {
              const secretDef = getSecretDef(name!);
              const tier = secretDef?.tier ?? "unknown";
              return {
                content: [
                  {
                    type: "text",
                    text: `❌ Access denied: '${name}' requires approval (tier: ${tier})\n\nRequest approval first: use secrets tool with action=request`,
                  },
                ],
                details: { ok: false, error: "grant_required", name, tier },
              };
            }
            throw error;
          }
        }

        case "request": {
          const secretDef = getSecretDef(name!);
          if (!secretDef) {
            throw new Error(`Secret '${name}' not registered`);
          }
          const text = `🔐 Secret requested: \`${name}\` (tier: ${secretDef.tier})\n\nApprove with: \`openclaw secrets grant ${name} <TOTP>\`\n\nDescription: ${secretDef.description || "No description"}`;
          return {
            content: [{ type: "text", text }],
            details: {
              ok: true,
              action: "request",
              name,
              tier: secretDef.tier,
              description: secretDef.description,
            },
          };
        }

        case "status": {
          const secretDef = getSecretDef(name!);
          if (!secretDef) {
            throw new Error(`Secret '${name}' not registered`);
          }

          const grantStatus = await checkGrant(name!);
          const baseDetails = { ok: true, name, tier: secretDef.tier };
          let text: string;
          let details: Record<string, unknown>;

          if (grantStatus.status === "valid") {
            const mins = Math.ceil(grantStatus.remaining / 60000);
            text = `✅ Grant status: ${name}\nTier: ${secretDef.tier}\nStatus: Valid\nExpires: ${new Date(grantStatus.expiresAt).toISOString()}\nRemaining: ${mins} minutes`;
            details = {
              ...baseDetails,
              status: "valid",
              expiresAt: grantStatus.expiresAt,
              remainingMinutes: mins,
            };
          } else if (grantStatus.status === "expired") {
            text = `⏰ Grant status: ${name}\nTier: ${secretDef.tier}\nStatus: Expired\nExpired at: ${new Date(grantStatus.expiredAt).toISOString()}\n\nRequest new approval with action=request`;
            details = { ...baseDetails, status: "expired", expiredAt: grantStatus.expiredAt };
          } else {
            text = `🔒 Grant status: ${name}\nTier: ${secretDef.tier}\nStatus: No grant\n\nRequest approval with action=request`;
            details = { ...baseDetails, status: "missing" };
          }

          return { content: [{ type: "text", text }], details };
        }

        case "list": {
          const secrets = await listSecrets();
          if (secrets.length === 0) {
            return {
              content: [{ type: "text", text: "No secrets registered" }],
              details: { ok: true, secrets: [] },
            };
          }

          const lines = ["OpenClaw Secrets:", ""];
          const detailsList: Array<{
            name: string;
            tier: string;
            description?: string;
            grantStatus: string;
          }> = [];

          for (const secret of secrets) {
            const grantStatus = await checkGrant(secret.name);
            let status: string;
            if (secret.tier === "open") {
              status = "always available";
            } else if (grantStatus.status === "valid") {
              status = `✅ ${Math.ceil(grantStatus.remaining / 60000)}m left`;
            } else if (grantStatus.status === "expired") {
              status = "⏰ expired";
            } else {
              status = "🔒 needs approval";
            }

            lines.push(`• ${secret.name} (${secret.tier}) — ${status}`);
            detailsList.push({
              name: secret.name,
              tier: secret.tier,
              description: secret.description,
              grantStatus: status,
            });
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
            details: { ok: true, secrets: detailsList },
          };
        }

        case "resolve": {
          // Returns a credentialRef string for use in tool params
          // In legacy/yolo: still validate the secret exists (via getSecret) but return ref, not value
          const mode = cfg.security?.credentials?.mode ?? "legacy";
          if (mode === "legacy" || mode === "yolo") {
            await getSecret(name!); // Validate it exists and is accessible
            return {
              content: [
                { type: "text", text: `Use credentialRef: "secret:${name}" in tool parameters` },
              ],
              details: { ok: true, ref: `secret:${name}`, name },
            };
          }
          const metadata = await getSecretMetadata(name!);
          return {
            content: [
              { type: "text", text: `Use credentialRef: "${metadata.ref}" in tool parameters` },
            ],
            details: { ok: true, ref: metadata.ref, name },
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
