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
  "Available placeholders:",
  "  {{prompt}}     — last user message as plain text",
  "  {{messages}}   — full conversation as JSON array",
  "  {{system}}     — system prompt text",
  "  {{model}}      — model ID string",
  "  {{max_tokens}} — max tokens number",
].join("\n");

function normalizeOptionalProviderApiKey(value: unknown): SecretInput | undefined {
  if (isSecretRef(value)) {
    return value;
  }
  return normalizeOptionalSecretInput(value);
}

function isValidJsonTemplate(value: string): boolean {
  const stripped = value
    .replace(/\{\{prompt\}\}/g, '"__placeholder__"')
    .replace(/\{\{messages\}\}/g, "[]")
    .replace(/\{\{system\}\}/g, '"__placeholder__"')
    .replace(/\{\{model\}\}/g, '"__placeholder__"')
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
}): Promise<{ config: OpenClawConfig; modelId: string; modelRef: string }> {
  const { prompter, cfg } = params;

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
        return "Must be valid JSON (placeholders like {{prompt}} are OK)";
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

  const baseUrl = endpointUrl.trim().replace(/\/+$/, "");
  const trimmedModelId = modelId.trim();
  const modelRef = `local-server/${trimmedModelId}`;
  const apiKey = normalizeOptionalProviderApiKey(apiKeyRaw?.trim() || undefined);

  let customHeaders: Record<string, string> | undefined;
  if (headersRaw?.trim()) {
    try {
      customHeaders = JSON.parse(headersRaw.trim()) as Record<string, string>;
    } catch {
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
        "local-server": {
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

  nextConfig = applyPrimaryModel(nextConfig, modelRef);

  return { config: nextConfig, modelId: trimmedModelId, modelRef };
}
