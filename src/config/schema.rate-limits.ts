export const LIMITS_FIELD_LABELS: Record<string, string> = {
  "limits.enabled": "Rate Limiting Enabled",
  "limits.defaults.rpm": "Default Requests Per Minute",
  "limits.defaults.tpm": "Default Tokens Per Minute",
  "limits.defaults.rpd": "Default Requests Per Day",
  "limits.defaults.dailyTokenBudget": "Default Daily Token Budget",
  "limits.defaults.monthlyTokenBudget": "Default Monthly Token Budget",
  "limits.queue.maxSize": "Rate Limit Queue Max Size",
  "limits.queue.timeoutMs": "Rate Limit Queue Timeout (ms)",
  "limits.budgets.warningThresholds": "Budget Warning Thresholds",
  "limits.budgets.hardBlock": "Budget Hard Block",
  "limits.retry.attempts": "Rate Limit Retry Attempts",
  "limits.retry.minDelayMs": "Rate Limit Retry Min Delay (ms)",
  "limits.retry.maxDelayMs": "Rate Limit Retry Max Delay (ms)",
  "limits.retry.jitter": "Rate Limit Retry Jitter",
};

export const LIMITS_FIELD_HELP: Record<string, string> = {
  "limits.enabled":
    "Enable rate limiting and budget controls for external API calls (default: true).",
  "limits.defaults.rpm": "Default requests per minute limit across all providers (default: 60).",
  "limits.defaults.tpm": "Default tokens per minute limit across all providers (default: 100,000).",
  "limits.defaults.rpd": "Default requests per day limit across all providers (0 = disabled).",
  "limits.defaults.dailyTokenBudget": "Default daily token budget (0 = disabled).",
  "limits.defaults.monthlyTokenBudget": "Default monthly token budget (0 = disabled).",
  "limits.queue.maxSize": "Maximum number of requests to queue when limits are exceeded.",
  "limits.queue.timeoutMs": "Maximum time a request can wait in the queue before being rejected.",
  "limits.budgets.warningThresholds":
    "Usage percentages at which to emit warnings (e.g. [0.8, 0.9, 1.0]).",
  "limits.budgets.hardBlock":
    "Whether to reject requests when the budget is exceeded (default: false).",
  "limits.retry.attempts": "Number of retry attempts for 429 rate limit errors.",
  "limits.retry.minDelayMs": "Rate Limit Retry Min Delay (ms)",
  "limits.retry.maxDelayMs": "Rate Limit Retry Max Delay (ms)",
  "limits.retry.jitter": "Rate Limit Retry Jitter",
};
