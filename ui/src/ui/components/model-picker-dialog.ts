import { html, nothing } from "lit";
import type { ModelEntry } from "../controllers/models";
import { icons } from "../icons";

export type { ModelEntry } from "../controllers/models";

export type ModelPickerDialogProps = {
  open: boolean;
  models: ModelEntry[];
  currentModel: string | null;
  onSelect: (modelId: string) => void;
  onClose: () => void;
};

type ModelsByProvider = Map<string, ModelEntry[]>;

function groupModelsByProvider(models: ModelEntry[]): ModelsByProvider {
  const grouped: ModelsByProvider = new Map();
  for (const model of models) {
    const provider = model.provider || "other";
    if (!grouped.has(provider)) {
      grouped.set(provider, []);
    }
    grouped.get(provider)!.push(model);
  }
  return grouped;
}

function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    "google-antigravity": "Google AG",
    "github-copilot": "GitHub Copilot",
    deepseek: "DeepSeek",
    groq: "Groq",
    mistral: "Mistral",
    zai: "Z.AI",
    xai: "xAI",
    other: "Other",
  };
  return names[provider.toLowerCase()] || provider;
}

function formatContextWindow(contextWindow: number | undefined): string {
  if (!contextWindow) return "";
  if (contextWindow >= 1_000_000) {
    return `${(contextWindow / 1_000_000).toFixed(1)}M`;
  }
  if (contextWindow >= 1_000) {
    return `${Math.round(contextWindow / 1_000)}K`;
  }
  return String(contextWindow);
}

function getProviderIcon(provider: string): string {
  const providerIcons: Record<string, string> = {
    openai: "🟢",
    anthropic: "🟠",
    google: "🔵",
    "google-antigravity": "🌀",
    "github-copilot": "🐙",
    deepseek: "🔮",
    groq: "⚡",
    mistral: "🌬️",
    zai: "💎",
    xai: "✖️",
  };
  return providerIcons[provider.toLowerCase()] || "🤖";
}

export function renderModelPickerDialog(props: ModelPickerDialogProps) {
  if (!props.open) return nothing;

  const grouped = groupModelsByProvider(props.models);
  const providers = Array.from(grouped.keys()).sort((a, b) => {
    // Sort by provider name, but put the current model's provider first
    const currentProvider = props.models.find((m) => m.id === props.currentModel)?.provider;
    if (a === currentProvider) return -1;
    if (b === currentProvider) return 1;
    return formatProviderName(a).localeCompare(formatProviderName(b));
  });

  const handleBackdropClick = (e: Event) => {
    if ((e.target as HTMLElement).classList.contains("model-picker-backdrop")) {
      props.onClose();
    }
  };

  // Use a single cleanup function that removes listener on ANY close
  const escapeHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose();
    }
  };

  // Add listener immediately
  document.addEventListener("keydown", escapeHandler);

  // Wrap onClose to ensure cleanup happens on any close method
  const handleCloseWithCleanup = () => {
    document.removeEventListener("keydown", escapeHandler);
    props.onClose();
  };

  const handleBackdropClickWithCleanup = (e: Event) => {
    if ((e.target as HTMLElement).classList.contains("model-picker-backdrop")) {
      handleCloseWithCleanup();
    }
  };

  // Focus dialog on next tick for accessibility
  setTimeout(() => {
    const dialog = document.querySelector(".model-picker-dialog") as HTMLElement;
    dialog?.focus();
  }, 0);

  return html`
    <div
      class="model-picker-backdrop"
      @click=${handleBackdropClickWithCleanup}
    >
      <div
        class="model-picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-picker-title"
        tabindex="0"
      >
        <div class="model-picker-header">
          <h2 id="model-picker-title" class="model-picker-title">Select Model</h2>
          <button
            class="model-picker-close"
            @click=${handleCloseWithCleanup}
            aria-label="Close"
            type="button"
          >
            ${icons.x}
          </button>
        </div>
        
        <div class="model-picker-content">
          ${providers.map((provider) => {
            const models = grouped.get(provider) || [];
            if (models.length === 0) return nothing;

            return html`
              <div class="model-picker-provider">
                <div class="model-picker-provider-header">
                  <span class="model-picker-provider-icon">${getProviderIcon(provider)}</span>
                  <span class="model-picker-provider-name">${formatProviderName(provider)}</span>
                  <span class="model-picker-provider-count">${models.length}</span>
                </div>
                <div class="model-picker-models">
                  ${models.map((model) => {
                    const isSelected = model.id === props.currentModel;
                    const contextStr = formatContextWindow(model.contextWindow);

                    return html`
                      <button
                        class="model-picker-model ${isSelected ? "model-picker-model--selected" : ""}"
                        @click=${() => {
                          props.onSelect(model.id);
                          handleCloseWithCleanup();
                        }}
                        type="button"
                      >
                        <div class="model-picker-model-main">
                          <span class="model-picker-model-name">${model.name || model.id}</span>
                          ${isSelected ? html`<span class="model-picker-model-check">${icons.check}</span>` : nothing}
                        </div>
                        <div class="model-picker-model-meta">
                          ${contextStr ? html`<span class="model-picker-model-context" title="Context window">${contextStr} ctx</span>` : nothing}
                          ${
                            model.reasoning
                              ? html`
                                  <span class="model-picker-model-badge" title="Reasoning/thinking model">🧠</span>
                                `
                              : nothing
                          }
                        </div>
                      </button>
                    `;
                  })}
                </div>
              </div>
            `;
          })}
        </div>
        
        <div class="model-picker-footer">
          <div class="model-picker-current">
            ${
              props.currentModel
                ? html`Current: <strong>${props.models.find((m) => m.id === props.currentModel)?.name || props.currentModel}</strong>`
                : html`
                    <em>No model selected</em>
                  `
            }
          </div>
        </div>
      </div>
    </div>
  `;
}
