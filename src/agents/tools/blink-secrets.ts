import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const OPERATIONS = ["set", "get_names", "delete"] as const;

const BlinkSecretsSchema = Type.Object({
  operation: Type.Union(OPERATIONS.map((op) => Type.Literal(op))),
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
      "Manage this agent's secret vault. Use 'set' to save a secret (API key, token, password), " +
      "'get_names' to list all stored key names, and 'delete' to remove a secret. " +
      "Values are encrypted and never returned — only key names are readable. " +
      "After saving, use $KEY_NAME in shell commands to access the value.",
    parameters: BlinkSecretsSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const operation = readStringParam(params, "operation", { required: true });

      if (operation === "get_names") {
        const res = await fetch(secretsUrl, { headers });
        if (!res.ok) throw new Error(`Failed to list secrets: ${res.status}`);
        const data = (await res.json()) as { secrets: Array<{ key: string }> };
        const keys = data.secrets.map((s) => s.key);
        return jsonResult({ keys, count: keys.length });
      }

      const key = readStringParam(params, "key", { required: true, trim: true })!
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, "_");

      if (operation === "set") {
        const value = readStringParam(params, "value", { required: true }) ?? "";
        const res = await fetch(secretsUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ key, value }),
        });
        if (!res.ok) throw new Error(`Failed to save secret: ${res.status}`);
        return jsonResult({
          ok: true,
          key,
          message: `Secret ${key} saved. Use $${key} in shell commands.`,
        });
      }

      if (operation === "delete") {
        const res = await fetch(`${secretsUrl}?key=${encodeURIComponent(key)}`, {
          method: "DELETE",
          headers,
        });
        if (!res.ok) throw new Error(`Failed to delete secret: ${res.status}`);
        return jsonResult({ ok: true, key, message: `Secret ${key} deleted.` });
      }

      throw new Error(`Unknown operation: ${operation}`);
    },
  };
}
