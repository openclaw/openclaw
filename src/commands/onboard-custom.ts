import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyPrimaryModel } from "./model-picker.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_CONTEXT_WINDOW = 4096;
const DEFAULT_MAX_TOKENS = 4096;

export async function promptCustomApiConfig(params: {
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  config: OpenClawConfig;
}): Promise<OpenClawConfig> {
  const { prompter, runtime, config } = params;

  // 1. Base URL
  const baseUrl = await prompter.text({
    message: "API Base URL",
    initialValue: DEFAULT_BASE_URL,
    placeholder: "http://localhost:11434/v1",
    validate: (val) => {
      try {
        new URL(val);
        return undefined;
      } catch {
        return "Please enter a valid URL (e.g. http://...)";
      }
    },
  });

  // 2. API Key
  const apiKey = await prompter.text({
    message: "API Key (optional for local)",
    placeholder: "sk-...",
    initialValue: "",
  });

  // 3. Smart Discovery
  let modelId: string | undefined;
  const spinner = prompter.progress("Connecting...");
  spinner.update(`Scanning models at ${baseUrl}...`);

  try {
    const discoveryUrl = new URL("models", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).href;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(discoveryUrl, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as { data?: { id: string }[]; models?: { id: string }[] };
      // Handle both OpenAI standard { data: [...] } and some variants { models: [...] }
      const rawModels = data.data || data.models || [];
      const models = rawModels.map((m: unknown) => {
        if (typeof m === "string") {
          return m;
        }
        if (typeof m === "object" && m !== null && "id" in m) {
          return (m as { id: string }).id;
        }
        return String(m);
      });

      if (models.length > 0) {
        spinner.stop(`Found ${models.length} models.`);
        const selection = await prompter.select({
          message: "Select a model",
          options: [
            ...models.map((id: string) => ({ value: id, label: id })),
            { value: "__manual", label: "(Enter manually...)" },
          ],
        });

        if (selection !== "__manual") {
          modelId = selection;
        }
      } else {
        spinner.stop("Connected, but no models list returned.");
      }
    } else {
      spinner.stop(`Connection succeeded, but discovery failed (${res.status}).`);
    }
  } catch {
    spinner.stop("Could not auto-detect models.");
  }

  // 4. Fallback Manual Input
  if (!modelId) {
    modelId = await prompter.text({
      message: "Model ID",
      placeholder: "e.g. llama3, gpt-4-local",
      validate: (val) => (val.trim() ? undefined : "Model ID is required"),
    });
  }

  // 5. Verification
  const verifySpinner = prompter.progress("Verifying...");
  let verified = false;
  try {
    const chatUrl = new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
      .href;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s for slow local inference

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(chatUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      verified = true;
      verifySpinner.stop("Verification successful.");
    } else {
      verifySpinner.stop(`Verification failed: status ${res.status}`);
    }
  } catch (err) {
    verifySpinner.stop(`Verification failed: ${String(err)}`);
  }

  if (!verified) {
    const confirm = await prompter.confirm({
      message: "Could not verify model connection. Save anyway?",
      initialValue: true,
    });
    if (!confirm) {
      return config;
    }
  }

  // 6. Update Config
  const providerId = "custom";
  let newConfig: OpenClawConfig = {
    ...config,
    models: {
      ...config.models,
      providers: {
        ...config.models?.providers,
        [providerId]: {
          baseUrl,
          apiKey: apiKey || undefined,
          api: "openai-completions" as const,
          models: [
            {
              id: modelId,
              name: `${modelId} (Custom)`,
              contextWindow: DEFAULT_CONTEXT_WINDOW,
              maxTokens: DEFAULT_MAX_TOKENS,
              input: ["text"] as ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
            },
          ],
        },
      },
    },
  };

  // Set as primary model
  newConfig = applyPrimaryModel(newConfig, `${providerId}/${modelId}`);

  runtime.log(`Configured custom provider: ${providerId}/${modelId}`);
  return newConfig;
}
