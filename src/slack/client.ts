import { type RetryOptions, type WebClientOptions, WebClient } from "@slack/web-api";

export const SLACK_DEFAULT_RETRY_OPTIONS: RetryOptions = {
  retries: 2,
  factor: 2,
  minTimeout: 500,
  maxTimeout: 3000,
  randomize: true,
};

/**
 * Resolve the Slack API URL to use.
 * Priority: 1) explicit option, 2) SLACK_API_URL env var, 3) undefined (uses default)
 */
function resolveSlackApiUrl(explicit?: string): string | undefined {
  if (explicit) {
    return explicit;
  }
  const envUrl = process.env.SLACK_API_URL?.trim();
  return envUrl || undefined;
}

export function resolveSlackWebClientOptions(options: WebClientOptions = {}): WebClientOptions {
  const slackApiUrl = resolveSlackApiUrl(options.slackApiUrl);
  return {
    ...options,
    ...(slackApiUrl ? { slackApiUrl } : {}),
    retryConfig: options.retryConfig ?? SLACK_DEFAULT_RETRY_OPTIONS,
  };
}

export function createSlackWebClient(token: string, options: WebClientOptions = {}) {
  return new WebClient(token, resolveSlackWebClientOptions(options));
}
