import type { ProviderUsageRequestResult } from "../../lib/provider-usage-request.ts";

const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;
const INCOMPLETE_USAGE_RETRY_LIMIT = 3;

type UsageRefreshReason = "focus" | "manual" | "poll" | "publication" | "reconnect";

type UsageRefreshPolicyOptions = {
  isLoading: () => boolean;
  reload: (reason: UsageRefreshReason) => void | Promise<void>;
  onIncompleteUsageExhausted?: () => void;
};

/** Owns Usage's page-specific TTL, interruption, and refresh coalescing policy. */
export class UsageRefreshPolicy {
  private lastLoadedAtMs: number | null = null;
  private pendingAutomaticRefresh = false;
  private publicationPending = false;
  private reloadPending = false;
  private retryTimer: number | null = null;
  private retryAttempts = 0;
  private exhaustionReported = false;
  private connection: unknown;

  constructor(private readonly options: UsageRefreshPolicyOptions) {}

  get incompleteUsageExhausted(): boolean {
    return this.exhaustionReported;
  }

  setLastLoadedAtMs(
    value: number | null,
    params?: { incomplete?: boolean; connection?: unknown },
  ): void {
    this.applyLoadState(value, params?.incomplete === true, params?.connection);
  }

  markProviderUsage(
    result: ProviderUsageRequestResult | null,
    value: number | null,
    connection: unknown,
  ): void {
    const incomplete =
      result?.ok === false || (result?.ok === true && result.value.refreshing === true);
    this.applyLoadState(value, incomplete, connection);
  }

  resetPayload(): void {
    this.applyLoadState(null, false);
    this.reloadPending = false;
    this.publicationPending = false;
  }

  dispose(): void {
    this.resetRetryCycle();
  }

  private applyLoadState(
    loadedAtMs: number | null,
    incomplete: boolean,
    connection?: unknown,
  ): void {
    if (connection !== this.connection) {
      this.connection = connection;
      this.resetRetryCycle();
    }
    if (!incomplete) {
      this.resetRetryCycle();
    } else if (this.retryTimer === null) {
      this.armRetry();
    }
    // Incomplete usage must not start the TTL or focus/reconnect can skip recovery.
    this.lastLoadedAtMs = incomplete ? null : loadedAtMs;
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
        void this.requestAndWait("poll").catch(() => undefined);
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
    this.reloadPending ||= this.options.isLoading();
  }

  markLoadDeferred(): void {
    this.reloadPending = true;
  }

  beginLoad(): void {
    this.reloadPending = false;
  }

  request(reason: UsageRefreshReason): void {
    void this.requestAndWait(reason);
  }

  private async requestAndWait(reason: UsageRefreshReason): Promise<void> {
    if (reason === "publication") {
      this.publicationPending = true;
      this.reloadPending = true;
    }
    if (this.options.isLoading() && reason !== "manual") {
      this.pendingAutomaticRefresh = true;
      return;
    }
    this.pendingAutomaticRefresh = false;
    if (
      reason !== "manual" &&
      (document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        (!this.reloadPending &&
          this.lastLoadedAtMs !== null &&
          Date.now() - this.lastLoadedAtMs < USAGE_PAYLOAD_TTL_MS))
    ) {
      return;
    }
    if (reason === "manual" || (reason !== "poll" && !this.publicationPending)) {
      this.resetRetryCycle();
    }
    this.publicationPending = false;
    await this.options.reload(reason);
  }

  flushPending(): void {
    if (!this.pendingAutomaticRefresh) {
      return;
    }
    this.pendingAutomaticRefresh = false;
    this.request("focus");
  }
}
