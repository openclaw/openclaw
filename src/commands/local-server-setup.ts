import type { OpenClawConfig } from "../config/config.js";
import type { LocalServerBodyTemplate } from "../config/types.models.js";
import { isSecretRef, type SecretInput } from "../config/types.secrets.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyPrimaryModel } from "./model-picker.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:8000";
const DEFAULT_CONTEXT_WINDOW = 65536;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const EXAMPLE_BODY_TEMPLATE = `{
  "prompt": "{{prompt}}",
  "max_tokens": 512,
  "temperature": 0.7
}`;

const PLACEHOLDER_HELP = [
  "Available placeholders (string placeholders must be inside quotes in the template):",
  '  "{{prompt}}"     — last user message as plain text',
  '  "{{system}}"     — system prompt text',
  '  "{{model}}"      — model ID string',
  "  {{max_tokens}}   — max tokens number (no quotes needed)",
  "  {{messages}}     — full conversation as JSON array (no quotes needed)",
].join("\n");

function normalizeOptionalProviderApiKey(value: unknown): SecretInput | undefined {
  if (isSecretRef(value)) {
    return value;
  }
  return normalizeOptionalSecretInput(value);
}

/**
 * Validate the template by substituting placeholders with unquoted sentinels
 * that match what substituteTemplate produces at runtime (i.e. the raw escaped
 * content, not a pre-quoted string).  This means string placeholders like
 * {{prompt}} must already be surrounded by quotes in the template:
 *   correct:   {"input": "{{prompt}}"}
 *   incorrect: {"input": {{prompt}}}
 */
function isValidJsonTemplate(value: string): boolean {
  const stripped = value
    .replace(/\{\{prompt\}\}/g, "__placeholder__")
    .replace(/\{\{messages\}\}/g, "[]")
    .replace(/\{\{system\}\}/g, "__placeholder__")
    .replace(/\{\{model\}\}/g, "__placeholder__")
    .replace(/\{\{max_tokens\}\}/g, "512");
  try {
    JSON.parse(stripped);
    return true;
  } catch {
    return false;
  }
}

export async function promptAndConfigureLocalServer(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  setDefaultModel?: boolean;
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const { prompter, cfg } = params;

  const providerId = await prompter.text({
    message: "Provider ID (unique name for this endpoint, e.g. my-server)",
    placeholder: "my-server",
    validate: (val) => {
      if (!val.trim()) {
        return "Provider ID is required";
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(val.trim())) {
        return "Use lowercase letters, digits, and hyphens only (e.g. my-server)";
      }
      return undefined;
    },
  });

  const endpointUrl = await prompter.text({
    message: "Server endpoint URL (full path)",
    initialValue: DEFAULT_BASE_URL,
    placeholder: "http://127.0.0.1:8000/generate",
    validate: (val) => {
      try {
        new URL(val);
        return undefined;
      } catch {
        return "Please enter a valid URL";
      }
    },
  });

  const modelId = await prompter.text({
    message: "Model identifier (any label for your model)",
    placeholder: "my-local-model",
    validate: (val) => (val.trim() ? undefined : "Model ID is required"),
  });

  await prompter.note(PLACEHOLDER_HELP, "Body template placeholders");

  const bodyTemplate = await prompter.text({
    message: "Request body template (JSON with placeholders)",
    initialValue: EXAMPLE_BODY_TEMPLATE,
    placeholder: '{"prompt": "{{prompt}}"}',
    validate: (val) => {
      if (!val.trim()) {
        return "Body template is required";
      }
      if (!isValidJsonTemplate(val)) {
        return 'Must be valid JSON. String placeholders must be quoted: {"input": "{{prompt}}"}';
      }
      return undefined;
    },
  });

  const responsePath = await prompter.text({
    message: "Response field path (dot-notation to extract generated text)",
    initialValue: "result.text",
    placeholder: "choices.0.message.content",
    validate: (val) => (val.trim() ? undefined : "Response path is required"),
  });

  const apiKeyRaw = await prompter.text({
    message: "API key (leave blank if not required)",
    placeholder: "sk-... or leave empty",
  });

  const headersRaw = await prompter.text({
    message: "Extra headers (JSON object, or leave blank)",
    placeholder: '{"X-Custom-Header": "value"}',
  });

  const trimmedProviderId = providerId.trim();
  const baseUrl = endpointUrl.trim().replace(/\/+$/, "");
  const trimmedModelId = modelId.trim();
  const modelRef = `${trimmedProviderId}/${trimmedModelId}`;
  const apiKey = normalizeOptionalProviderApiKey(apiKeyRaw?.trim() || undefined);

  let customHeaders: Record<string, string> | undefined;
  if (headersRaw?.trim()) {
    try {
      customHeaders = JSON.parse(headersRaw.trim()) as Record<string, string>;
    } catch {
      await prompter.note(
        "Could not parse headers as JSON — extra headers have been skipped.",
        "Warning",
      );
      customHeaders = undefined;
    }
  }

  const localServerConfig: LocalServerBodyTemplate = {
    template: bodyTemplate.trim(),
    responsePath: responsePath.trim(),
  };

  let nextConfig: OpenClawConfig = {
    ...cfg,
    models: {
      ...cfg.models,
      mode: cfg.models?.mode ?? "merge",
      providers: {
        ...cfg.models?.providers,
        [trimmedProviderId]: {
          baseUrl,
          api: "local-server",
          ...(apiKey ? { apiKey } : {}),
          ...(customHeaders ? { headers: customHeaders } : {}),
          localServer: localServerConfig,
          models: [
            {
              id: trimmedModelId,
              name: `${trimmedModelId} (Local Server)`,
              reasoning: false,
              input: ["text"],
              cost: DEFAULT_COST,
              contextWindow: DEFAULT_CONTEXT_WINDOW,
              maxTokens: DEFAULT_MAX_TOKENS,
            },
          ],
        },
      },
    },
  };

  if (params.setDefaultModel !== false) {
    nextConfig = applyPrimaryModel(nextConfig, modelRef);
  }

  return { config: nextConfig, modelId: trimmedModelId, modelRef };
}
