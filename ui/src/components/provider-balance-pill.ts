import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";

/**
 * Provider balance chip.
 *
 * Sits in the composer control row, immediately left of the model picker.
 * Shows the live provider account balance with the provider's brand color and
 * logo, and opens that provider's billing console in a new tab on click.
 *
 * Everything brand-related can be overridden from `gateway.controlUi.balanceChip`
 * in openclaw.json, which the gateway forwards through the Control UI bootstrap
 * config. Missing or malformed overrides fall back to the table below.
 */

type ProviderBrand = {
  label: string;
  color: string;
  consoleUrl: string;
  /** ProviderIcon-<icon>.svg shipped under /provider-icons. */
  icon: string | null;
  currencyPrefix: string;
};

/** Built-in defaults. Operator config layers on top of these. */
const BRANDS: Record<string, ProviderBrand> = {
  deepseek: {
    label: "DeepSeek",
    color: "#4d6bfe",
    consoleUrl: "https://platform.deepseek.com/usage",
    icon: "deepseek",
    currencyPrefix: "¥",
  },
  anthropic: {
    label: "Claude",
    color: "#d97757",
    consoleUrl: "https://console.anthropic.com/settings/billing",
    icon: "claude",
    currencyPrefix: "$",
  },
  openai: {
    label: "OpenAI",
    color: "#10a37f",
    consoleUrl: "https://platform.openai.com/usage",
    icon: "codex",
    currencyPrefix: "$",
  },
  google: {
    label: "Gemini",
    color: "#4285f4",
    consoleUrl: "https://aistudio.google.com/apikey",
    icon: "gemini",
    currencyPrefix: "$",
  },
  gemini: {
    label: "Gemini",
    color: "#4285f4",
    consoleUrl: "https://aistudio.google.com/apikey",
    icon: "gemini",
    currencyPrefix: "$",
  },
  moonshot: {
    label: "Moonshot",
    color: "#1f1f1f",
    consoleUrl: "https://platform.moonshot.cn/console/info",
    icon: "kimi",
    currencyPrefix: "¥",
  },
  kimi: {
    label: "Kimi",
    color: "#1f1f1f",
    consoleUrl: "https://platform.moonshot.cn/console/info",
    icon: "kimi",
    currencyPrefix: "¥",
  },
  zhipu: {
    label: "GLM",
    color: "#3859ff",
    consoleUrl: "https://bigmodel.cn/finance/accountcenter",
    icon: "zai",
    currencyPrefix: "¥",
  },
  "z-ai": {
    label: "GLM",
    color: "#3859ff",
    consoleUrl: "https://bigmodel.cn/finance/accountcenter",
    icon: "zai",
    currencyPrefix: "¥",
  },
  xai: {
    label: "Grok",
    color: "#111111",
    consoleUrl: "https://console.x.ai/",
    icon: "grok",
    currencyPrefix: "$",
  },
  grok: {
    label: "Grok",
    color: "#111111",
    consoleUrl: "https://console.x.ai/",
    icon: "grok",
    currencyPrefix: "$",
  },
  openrouter: {
    label: "OpenRouter",
    color: "#6467f2",
    consoleUrl: "https://openrouter.ai/credits",
    icon: "openrouter",
    currencyPrefix: "$",
  },
  mistral: {
    label: "Mistral",
    color: "#ff7000",
    consoleUrl: "https://console.mistral.ai/billing",
    icon: "mistral",
    currencyPrefix: "€",
  },
  groq: {
    label: "Groq",
    color: "#f55036",
    consoleUrl: "https://console.groq.com/settings/billing",
    icon: "groq",
    currencyPrefix: "$",
  },
  ollama: {
    label: "Ollama",
    color: "#22c55e",
    consoleUrl: "https://ollama.com/settings/keys",
    icon: "ollama",
    currencyPrefix: "$",
  },
  minimax: {
    label: "MiniMax",
    color: "#f23c5c",
    consoleUrl: "https://platform.minimaxi.com/user-center/basic-information",
    icon: "minimax",
    currencyPrefix: "¥",
  },
  doubao: {
    label: "Doubao",
    color: "#325ab4",
    consoleUrl: "https://console.volcengine.com/ark",
    icon: "doubao",
    currencyPrefix: "¥",
  },
};

/** i18n fallback used when no operator label is configured. */
function defaultLabel(): string {
  return t("chat.balanceChipLabel");
}
const DEFAULT_LOW_BALANCE_THRESHOLD = 1;
const DEFAULT_REFRESH_INTERVAL_MS = 20_000;
const MIN_REFRESH_INTERVAL_MS = 5_000;

/** Subset of the gateway bootstrap config this component cares about. */
export type BalanceChipOverride = {
  label?: string;
  lowBalanceThreshold?: number;
  refreshIntervalMs?: number;
  providers?: Record<
    string,
    {
      label?: string;
      color?: string;
      url?: string;
      icon?: string;
      currency?: string;
    }
  >;
};

type BillingEntry = {
  type?: string;
  amount?: number;
  unit?: string;
};

type UsageWindow = {
  displayName?: string;
  label?: string;
  remaining?: number;
  resetAt?: number;
};

type ProviderUsageEntry = {
  provider?: string;
  displayName?: string;
  billing?: BillingEntry[];
  windows?: UsageWindow[];
  summary?: string;
  error?: string;
  plan?: string;
};

type UsageSummary = {
  providers?: ProviderUsageEntry[];
};

export type ProviderBalancePillProps = {
  basePath?: string;
  client?: GatewayBrowserClient | null;
  connected?: boolean;
  /** Changes after each completed assistant turn to trigger a refresh. */
  refreshToken?: number | string | null;
  /** Provider id used by the latest turn, e.g. "deepseek". */
  activeProvider?: string | null;
  /** Called after a balance fetch settles so the host can repaint. */
  onNeedsRepaint?: () => void;
  /** Operator overrides from `gateway.controlUi.balanceChip`. */
  overrides?: BalanceChipOverride | null;
};

type CacheEntry = { at: number; summary: UsageSummary | null };
let cached: CacheEntry | null = null;
let inflight: Promise<UsageSummary | null> | null = null;
let requestGeneration = 0;
let lastForcedToken: string | number | null | undefined;

/** Subscribers that need a repaint when a balance request settles. */
const repainters = new Set<() => void>();

function notifyRepainters() {
  for (const fn of repainters) {
    try {
      fn();
    } catch {
      // ignore listener failures
    }
  }
}

async function loadUsage(
  client: GatewayBrowserClient | null | undefined,
  force: boolean,
): Promise<UsageSummary | null> {
  if (!client) {
    return null;
  }
  if (!force && cached && Date.now() - cached.at < cacheTtlMs) {
    return cached.summary;
  }
  if (inflight) {
    return inflight;
  }
  const generation = ++requestGeneration;
  inflight = client
    .request<UsageSummary>("usage.status", {})
    .then((summary) => {
      if (generation <= requestGeneration) {
        cached = { at: Date.now(), summary };
      }
      notifyRepainters();
      return summary;
    })
    .catch(() => cached?.summary ?? null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

let cacheTtlMs = DEFAULT_REFRESH_INTERVAL_MS;

function formatAmount(amount: number, unit: string | undefined, fallback: string): string {
  const normalized = (unit ?? "").trim().toUpperCase();
  const prefix =
    normalized === "CNY" || normalized === "RMB" || normalized === "CNH"
      ? "¥"
      : normalized === "USD"
        ? "$"
        : normalized === "EUR"
          ? "€"
          : normalized
            ? `${normalized} `
            : fallback;
  return `${prefix}${amount.toFixed(2)}`;
}

/**
 * Resolve brand presentation: built-in defaults, then operator overrides
 * matched by case-insensitive substring, then a neutral fallback.
 */
function resolveBrand(
  entry: ProviderUsageEntry,
  activeProvider: string | null | undefined,
  overrides: BalanceChipOverride | null | undefined,
): ProviderBrand {
  const id = (entry.provider ?? activeProvider ?? "").toLowerCase();
  let base: ProviderBrand | null = null;
  for (const key of Object.keys(BRANDS)) {
    if (id.includes(key)) {
      base = BRANDS[key];
      break;
    }
  }
  const fallback: ProviderBrand = base ?? {
    label: entry.displayName || entry.provider || "Provider",
    color: "var(--accent, #4d6bfe)",
    consoleUrl: "",
    icon: null,
    currencyPrefix: "",
  };
  if (!overrides?.providers) {
    return fallback;
  }
  // Longest matching key wins so "z-ai" beats "z".
  const matches = Object.keys(overrides.providers)
    .filter((key) => key && id.includes(key.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  const override = matches.length > 0 ? overrides.providers[matches[0]] : null;
  if (!override) {
    return fallback;
  }
  return {
    label: override.label ?? fallback.label,
    color: override.color ?? fallback.color,
    consoleUrl: override.url ?? fallback.consoleUrl,
    icon: override.icon ?? fallback.icon,
    currencyPrefix: override.currency ?? fallback.currencyPrefix,
  };
}

function pickEntry(
  summary: UsageSummary | null,
  activeProvider?: string | null,
): ProviderUsageEntry | null {
  const providers = summary?.providers ?? [];
  if (!providers.length) {
    return null;
  }
  const target = (activeProvider ?? "").toLowerCase().trim();
  if (target) {
    const match = providers.find((entry) => (entry.provider ?? "").toLowerCase().includes(target));
    if (match) {
      return match;
    }
  }
  return providers.find((entry) => (entry.billing ?? []).length > 0) ?? providers[0] ?? null;
}

function resolveIconUrl(
  brand: ProviderBrand,
  basePath: string | undefined,
): string | null {
  if (!brand.icon) {
    return null;
  }
  // Absolute URLs and root-relative paths pass through untouched.
  if (/^(?:https?:\/\/|\/|\.\.?\/)/iu.test(brand.icon)) {
    return brand.icon;
  }
  if (!/^[a-z0-9-]+$/iu.test(brand.icon)) {
    return null;
  }
  return inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${brand.icon}.svg`, {
    basePath,
  });
}

export function renderProviderBalancePill(props: ProviderBalancePillProps) {
  const overrides = props.overrides ?? null;
  if (overrides && (overrides as { enabled?: boolean }).enabled === false) {
    return nothing;
  }
  if (!props.connected || !props.client) {
    return nothing;
  }

  cacheTtlMs = Math.max(
    MIN_REFRESH_INTERVAL_MS,
    overrides?.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
  );

  // Only force a network refresh when the token actually changes; repeating
  // renders with the same token must not hammer the gateway.
  const force = cached !== null && props.refreshToken !== lastForcedToken;
  if (force) {
    lastForcedToken = props.refreshToken;
  }
  const pending = loadUsage(props.client, force);

  // First paint has no data yet: show a neutral placeholder instead of
  // collapsing to nothing, then swap in the real chip once it lands.
  if (!cached?.summary) {
    if (props.onNeedsRepaint) {
      repainters.add(props.onNeedsRepaint);
    }
    void pending.then((summary) => {
      if (!summary && props.onNeedsRepaint) {
        repainters.delete(props.onNeedsRepaint);
      }
    });
    return html`
      <span
        class="provider-balance-pill provider-balance-pill--loading"
        title=${t("chat.balanceChipLoading")}
        aria-busy="true"
      >
        <span class="provider-balance-pill__dot" aria-hidden="true"></span>
        <span class="provider-balance-pill__label">${overrides?.label ?? defaultLabel()}</span>
        <span class="provider-balance-pill__value">…</span>
      </span>
    `;
  }

  const entry = pickEntry(cached.summary, props.activeProvider);
  if (!entry) {
    return nothing;
  }
  const brand = resolveBrand(entry, props.activeProvider, overrides);
  const billing = (entry.billing ?? []).find((item) => typeof item.amount === "number");
  const primaryWindow = (entry.windows ?? [])[0];

  let valueText: string | null = null;
  let fallbackLabel = defaultLabel();
  if (billing && typeof billing.amount === "number") {
    valueText = formatAmount(billing.amount, billing.unit, brand.currencyPrefix);
  } else if (primaryWindow && typeof primaryWindow.remaining === "number") {
    valueText = `${primaryWindow.remaining}%`;
    fallbackLabel = t("chat.balanceChipRemaining");
  } else if (entry.summary) {
    valueText = entry.summary.replace(/^Balance\s*/i, "");
  } else if (entry.error) {
    valueText = "—";
  }
  if (!valueText) {
    return nothing;
  }

  const labelText = overrides?.label ?? fallbackLabel;
  const threshold = overrides?.lowBalanceThreshold ?? DEFAULT_LOW_BALANCE_THRESHOLD;
  const lowBalance = Boolean(
    billing && typeof billing.amount === "number" && billing.amount > 0 && billing.amount < threshold,
  );

  const iconUrl = resolveIconUrl(brand, props.basePath);

  const title = [
    `${brand.label} ${labelText} ${valueText}`,
    entry.summary,
    brand.consoleUrl
      ? t("chat.balanceChipOpenConsole", { provider: brand.label })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const handleClick = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (brand.consoleUrl) {
      window.open(brand.consoleUrl, "_blank", "noopener,noreferrer");
      return;
    }
    // No known console: refresh the number instead of doing nothing.
    void loadUsage(props.client, true);
  };

  return html`
    <button
      type="button"
      class="provider-balance-pill ${lowBalance ? "provider-balance-pill--low" : ""}"
      style=${`--balance-brand:${brand.color}`}
      title=${title}
      aria-label=${`${brand.label} ${labelText} ${valueText}`}
      data-provider-balance=${entry.provider ?? "unknown"}
      @click=${handleClick}
    >
      ${iconUrl
        ? html`<span
            class="provider-balance-pill__icon"
            style=${`--provider-icon-url: url("${iconUrl}")`}
            aria-hidden="true"
          ></span>`
        : html`<span class="provider-balance-pill__dot" aria-hidden="true"></span>`}
      <span class="provider-balance-pill__label">${labelText}</span>
      <span class="provider-balance-pill__value">${valueText}</span>
    </button>
  `;
}

/** Drops cached state; used by tests and after a provider switch. */
export function __resetProviderBalanceCache() {
  cached = null;
  inflight = null;
  requestGeneration += 1;
  lastForcedToken = undefined;
  cacheTtlMs = DEFAULT_REFRESH_INTERVAL_MS;
  repainters.clear();
}
