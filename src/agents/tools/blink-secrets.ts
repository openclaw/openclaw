import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const BlinkSecretsSchema = Type.Object({
  operation: Type.Union([
    Type.Literal("set"),
    Type.Literal("get_names"),
    Type.Literal("delete"),
  ]),
  key: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
});

function resolveBlinkClawEnv(): { apiKey: string; agentId: string; baseUrl: string } | null {
  const apiKey = process.env.BLINK_API_KEY;
  const agentId = process.env.BLINK_AGENT_ID;
  if (!apiKey || !agentId) return null;
  const baseUrl = process.env.BLINK_CLAW_URL ?? "https://blink.new";
  return { apiKey, agentId, baseUrl };
}

export function createBlinkSecretsTool(): AnyAgentTool | null {
  const env = resolveBlinkClawEnv();
  if (!env) return null;

  const { apiKey, agentId, baseUrl } = env;
  const secretsUrl = `${baseUrl}/api/claw/agents/${agentId}/secrets`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "x-blink-agent-id": agentId,
  };

  return {
    label: "Blink Secrets",
    name: "blink_claw_secrets",
    description:
      "Manage this agent's encrypted secret vault. Use 'set' to save an API key, token, or password " +
      "(the value is encrypted and never returned after saving). " +
      "Use 'get_names' to list all stored key names. " +
      "Use 'delete' to remove a secret. " +
      "After saving with 'set', the agent restarts (~30s) and the value becomes available as $KEY_NAME in shell commands.",
    parameters: BlinkSecretsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const operation = readStringParam(params, "operation", { required: true });

      if (operation === "get_names") {
        const res = await fetch(secretsUrl, { headers });
        if (!res.ok) throw new Error(`Failed to list secrets: HTTP ${res.status}`);
        const data = (await res.json()) as { secrets: Array<{ key: string }> };
        const keys = data.secrets.map((s) => s.key);
        return jsonResult({ keys, count: keys.length });
      }

      const key = readStringParam(params, "key", { required: true, trim: true })!
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_");

      if (operation === "set") {
        // Use allowEmpty: true so the agent can set an empty-string value to clear a secret
        const value = readStringParam(params, "value", { allowEmpty: true }) ?? "";
        const res = await fetch(secretsUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ key, value }),
        });
        if (!res.ok) throw new Error(`Failed to save secret: HTTP ${res.status}`);
        return jsonResult({
          ok: true,
          key,
          message: `Secret ${key} saved. Agent is restarting to apply (~30s). After restart, use $${key} in shell commands.`,
        });
      }

      if (operation === "delete") {
        const res = await fetch(`${secretsUrl}?key=${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers,
        });
        if (!res.ok) throw new Error(`Failed to delete secret: HTTP ${res.status}`);
        return jsonResult({ ok: true, key, message: `Secret ${key} deleted.` });
      }

      throw new Error(`Unknown operation: ${operation}`);
    },
  };
}
