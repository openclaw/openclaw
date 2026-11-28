const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
const INCOMPLETE_USAGE_RETRY_LIMIT = 3;

type UsageRefreshReason = "focus" | "manual" | "poll" | "publication" | "reconnect";

type UsageRefreshPolicyOptions = {
  isSessionLoading: () => boolean;
  isProviderLoading: () => boolean;
  reload: (reads: {
    sessions: boolean;
    provider: boolean;
    manual?: boolean;
  }) => void | Promise<void>;
  onIncompleteUsageExhausted?: () => void;
};

/** Owns Usage's page-specific TTL, interruption, and refresh coalescing policy. */
export class UsageRefreshPolicy {
  private sessionsLoadedAtMs: number | null = null;
  private providerLoadedAtMs: number | null = null;
  private activationPending = false;
  private pollPending = false;
  private publicationPending = false;
  private reloadPending = false;
  private retryTimer: number | null = null;
  private retryAttempts = 0;
  private exhaustionReported = false;

  constructor(private readonly options: UsageRefreshPolicyOptions) {}

  get incompleteUsageExhausted(): boolean {
    return this.exhaustionReported;
  }

  markSessionsLoaded(loadedAtMs: number | null): void {
    this.sessionsLoadedAtMs = loadedAtMs;
  }

  markProviderLoaded(loadedAtMs: number | null): void {
    this.providerLoadedAtMs = loadedAtMs;
    if (loadedAtMs !== null) {
      this.pollPending = false;
      this.resetRetryCycle();
    } else if (this.retryTimer === null && !this.pollPending) {
      this.armRetry();
    }
  }

  resetPayload(): void {
    this.sessionsLoadedAtMs = null;
    this.providerLoadedAtMs = null;
    this.activationPending = false;
    this.pollPending = false;
    this.reloadPending = false;
    this.publicationPending = false;
    this.resetRetryCycle();
  }

  dispose(): void {
    this.resetRetryCycle();
  }

  private armRetry(): void {
    if (this.retryAttempts >= INCOMPLETE_USAGE_RETRY_LIMIT) {
      if (!this.exhaustionReported) {
        this.exhaustionReported = true;
        this.options.onIncompleteUsageExhausted?.();
      }
      return;
    }
    this.retryAttempts += 1;
    // Let the Gateway's 30s aggregate cache expire without increasing request volume.
    this.retryTimer = window.setTimeout(
      () => {
        this.retryTimer = null;
        void this.request("poll").catch(() => undefined);
      },
      5_000 * 2 ** (this.retryAttempts - 1),
    );
  }

  private resetRetryCycle(): void {
    this.retryAttempts = 0;
    this.exhaustionReported = false;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  interrupt(): void {
    this.reloadPending ||= this.options.isSessionLoading();
  }

  markLoadDeferred(): void {
    this.reloadPending = true;
  }

  beginSessionsLoad(): void {
    this.reloadPending = false;
    // This query starts after every publication received so far, but does not read provider plans.
    this.publicationPending = false;
  }

  async request(reason: UsageRefreshReason): Promise<void> {
    if (reason === "manual") {
      this.activationPending = false;
      this.pollPending = false;
      this.resetRetryCycle();
      return this.options.reload({ sessions: true, provider: true, manual: true });
    }
    if (reason === "publication") {
      this.publicationPending = true;
    } else if (reason === "poll") {
      this.pollPending = true;
    } else {
      this.activationPending = true;
      if (reason === "reconnect") {
        this.resetRetryCycle();
      }
    }
    return this.flushPending();
  }

  async flushPending(): Promise<void> {
    if (
      this.options.isSessionLoading() ||
      document.visibilityState !== "visible" ||
      !document.hasFocus()
    ) {
      return;
    }
    const now = Date.now();
    const expired = (loadedAtMs: number | null) =>
      loadedAtMs === null || now - loadedAtMs >= USAGE_PAYLOAD_TTL_MS;
    const sessions =
      this.publicationPending ||
      (this.activationPending && (this.reloadPending || expired(this.sessionsLoadedAtMs)));
    const provider =
      !this.options.isProviderLoading() &&
      (this.pollPending || (this.activationPending && expired(this.providerLoadedAtMs)));
    this.activationPending = false;
    if (provider) {
      if (!this.pollPending && !this.publicationPending) {
        this.resetRetryCycle();
      }
      this.pollPending = false;
    }
    if (sessions || provider) {
      await this.options.reload({ sessions, provider });
    }
  }
}
