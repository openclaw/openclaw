import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { SUGGESTED_PROVIDERS } from "@/lib/onboarding-utils";

type Props = { onValidChange: (valid: boolean) => void };

type TestStatus = "idle" | "testing" | "success" | "error";

const REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

type ProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  models?: Array<{ id: string; name?: string }>;
  [key: string]: unknown;
};

type ConfigInner = {
  models?: {
    providers?: Record<string, ProviderConfig>;
  };
  env?: Record<string, string>;
  auth?: {
    profiles?: Record<string, { provider?: string; mode?: string }>;
  };
};

// config.get returns a ConfigFileSnapshot wrapper, not a flat config object
type ConfigGetResponse = {
  config?: ConfigInner;
  resolved?: ConfigInner;
  parsed?: unknown;
  hash?: string;
  [key: string]: unknown;
};

type DetectedProvider = {
  id: string;
  name: string;
  hasKey: boolean;
};

function detectConfiguredProviders(config: ConfigInner): DetectedProvider[] {
  const detected: DetectedProvider[] = [];
  const seenIds = new Set<string>();
  const providers = config?.models?.providers ?? {};
  const env = config?.env ?? {};

  // Any provider in models.providers is configured (key may be in env, not inline)
  for (const [id, providerCfg] of Object.entries(providers)) {
    // Check for inline apiKey OR a matching env var like ZAI_API_KEY, OPENAI_API_KEY, etc.
    const envKeyName = `${id.toUpperCase()}_API_KEY`;
    const hasKey =
      providerCfg.apiKey === REDACTED_SENTINEL ||
      env[envKeyName] !== undefined ||
      providerCfg.baseUrl !== undefined; // Has a baseUrl = configured endpoint
    detected.push({
      id,
      name: id.charAt(0).toUpperCase() + id.slice(1),
      hasKey,
    });
    seenIds.add(id);
  }

  // Scan env for *_API_KEY patterns that might indicate additional providers
  for (const envKey of Object.keys(env)) {
    const match = envKey.match(/^(.+?)_API_KEY$/);
    if (match) {
      const id = match[1].toLowerCase();
      if (!seenIds.has(id)) {
        detected.push({
          id,
          name: id.charAt(0).toUpperCase() + id.slice(1),
          hasKey: true,
        });
        seenIds.add(id);
      }
    }
  }

  // Check auth profiles for additional providers
  const profiles = config?.auth?.profiles ?? {};
  for (const [, profile] of Object.entries(profiles)) {
    if (profile.provider && !seenIds.has(profile.provider)) {
      const id = profile.provider;
      detected.push({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        hasKey: profile.mode === "api_key",
      });
      seenIds.add(id);
    }
  }

  return detected;
}

export function StepProvider({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const [selectedProvider, setSelectedProvider] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<DetectedProvider[]>([]);
  const [detecting, setDetecting] = useState(true);

  const isOllama = selectedProvider === "ollama";
  const isAlreadyConfigured = configuredProviders.some(
    (p) => p.id === selectedProvider && p.hasKey,
  );

  // Auto-detect existing provider config on mount
  useEffect(() => {
    const detect = async () => {
      try {
        // config.get returns a ConfigFileSnapshot wrapper; actual config is in .config
        const response = await sendRpc<ConfigGetResponse>("config.get", {});
        const config: ConfigInner = response.config ?? response.resolved ?? {};
        const detected = detectConfiguredProviders(config);
        setConfiguredProviders(detected);

        if (detected.length > 0) {
          setSelectedProvider(detected[0].id);
          setTestStatus("success");
        }
      } catch {
        // config.get not available
      } finally {
        setDetecting(false);
      }
    };
    void detect();
  }, [sendRpc]);

  // Load models when provider is selected
  const loadModels = useCallback(async () => {
    if (!selectedProvider) {
      return;
    }
    try {
      const result = await sendRpc<{ models: Array<{ id: string }> }>("models.list", {
        provider: selectedProvider,
      });
      const modelIds = result.models?.map((m) => m.id) ?? [];
      setAvailableModels(modelIds);
      if (modelIds.length > 0 && !selectedModel) {
        setSelectedModel(modelIds[0]);
      }
    } catch {
      // Use suggested models as fallback
      const provider = SUGGESTED_PROVIDERS.find((p) => p.id === selectedProvider);
      if (provider?.models.length) {
        setAvailableModels([...provider.models]);
        if (!selectedModel) {
          setSelectedModel(provider.models[0]);
        }
      }
    }
  }, [selectedProvider, selectedModel, sendRpc]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleTest = useCallback(async () => {
    setTestStatus("testing");
    setTestError(null);
    try {
      const configPatch: Record<string, string> = {};
      if (selectedProvider && !isOllama) {
        configPatch[`providers.${selectedProvider}.apiKey`] = apiKey;
      }
      if (selectedModel) {
        configPatch["ai.model"] = selectedModel;
      }
      if (Object.keys(configPatch).length > 0) {
        await sendRpc("config.patch", { values: configPatch });
      }
      await sendRpc("models.list", { provider: selectedProvider });
      setTestStatus("success");
    } catch (err) {
      setTestStatus("error");
      setTestError(err instanceof Error ? err.message : "Connection test failed");
    }
  }, [selectedProvider, apiKey, selectedModel, isOllama, sendRpc]);

  // Valid when provider is configured or test passed
  useEffect(() => {
    onValidChange(testStatus === "success" || isOllama || isAlreadyConfigured);
  }, [testStatus, isOllama, isAlreadyConfigured, onValidChange]);

  if (detecting) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Detecting configuration...</span>
      </div>
    );
  }

  // Build the provider list: configured first, then suggestions
  const allProviders: Array<{ id: string; name: string; configured: boolean }> = [];
  const seenIds = new Set<string>();

  for (const cp of configuredProviders) {
    allProviders.push({ id: cp.id, name: cp.name, configured: true });
    seenIds.add(cp.id);
  }
  for (const sp of SUGGESTED_PROVIDERS) {
    if (!seenIds.has(sp.id)) {
      allProviders.push({ id: sp.id, name: sp.name, configured: false });
      seenIds.add(sp.id);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">AI Provider</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {configuredProviders.length > 0
            ? `${configuredProviders.length} provider${configuredProviders.length !== 1 ? "s" : ""} detected. You can change the selection or continue.`
            : "Choose which AI provider to use for your agents."}
        </p>
      </div>

      {/* Provider selection */}
      <div className="grid grid-cols-2 gap-3">
        {allProviders.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => {
              setSelectedProvider(provider.id);
              if (!provider.configured) {
                setTestStatus("idle");
                setApiKey("");
                setSelectedModel("");
              } else {
                setTestStatus("success");
              }
              setTestError(null);
              setAvailableModels([]);
            }}
            className={`rounded-lg border p-4 text-left transition-colors ${
              selectedProvider === provider.id
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">{provider.name}</span>
              {provider.configured && <CheckCircle2 className="h-4 w-4 text-primary" />}
            </div>
          </button>
        ))}
      </div>

      {selectedProvider && (
        <div className="space-y-4 rounded-lg border border-border p-4">
          {/* Show configured status */}
          {isAlreadyConfigured && (
            <div className="flex items-center gap-2 text-sm text-primary">
              <CheckCircle2 className="h-4 w-4" />
              Already configured
            </div>
          )}

          {/* API Key (only for new, non-Ollama providers) */}
          {!isOllama && !isAlreadyConfigured && (
            <div>
              <label className="text-sm font-medium block mb-1.5">API Key</label>
              <Input
                type="password"
                placeholder={`Enter your ${selectedProvider} API key`}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setTestStatus("idle");
                }}
              />
            </div>
          )}

          {/* Model selector */}
          {availableModels.length > 0 && (
            <div>
              <label className="text-sm font-medium block mb-1.5">Model</label>
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Test connection (only for new providers) */}
          {!isAlreadyConfigured && (
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={handleTest}
                disabled={testStatus === "testing" || (!isOllama && !apiKey)}
              >
                {testStatus === "testing" && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                Test Connection
              </Button>
              {testStatus === "success" && (
                <span className="flex items-center gap-1 text-sm text-primary">
                  <CheckCircle2 className="h-4 w-4" /> Connected
                </span>
              )}
              {testStatus === "error" && (
                <span className="flex items-center gap-1 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4" /> {testError}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
