import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isGatewayRestartUnavailableError } from "../../../packages/gateway-protocol/src/restart-unavailable.ts";
import {
  CRON_FAILURE_DISMISSALS_KEY,
  readCronFailureDismissals,
} from "../../../packages/gateway-protocol/src/schema/cron-failure-dismissals.ts";
import type { UsersPrefsGetResult } from "../../../packages/gateway-protocol/src/schema/users.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import { showToast } from "../lib/toast.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import {
  deferredCronFailurePrefix,
  loadDismissals,
  saveDismissals,
  type SidebarAttentionDismissals,
} from "./sidebar-attention-dismissals.ts";

/** Remove only an imported v2 job ID. Another tab may have saved unrelated alerts. */
function retireLegacyCronDismissal(key: string, id: string): SidebarAttentionDismissals {
  const stored = loadDismissals(key);
  if (!stored.cronFailed?.includes(id)) {
    return stored;
  }
  stored.cronFailed = stored.cronFailed.filter((candidate) => candidate !== id);
  if (!stored.cronFailed.length) {
    delete stored.cronFailed;
  }
  saveDismissals(key, stored);
  return stored;
}

/** Receipts for one authenticated browser connection and its gateway profile. */
export class CronFailureDismissals {
  #receipts = new Map<string, number>();
  #pending = new Map<string, number>();
  #reading = false;
  #readAgain = false;
  #loaded = false;
  #disposed = false;
  #adopting = false;
  #imports = new Set<string>();
  #deferred = new Map<string, number>();
  #retry?: ReturnType<typeof globalThis.setTimeout>;
  readonly #stopPreferences: () => void;

  constructor(
    readonly key: string,
    readonly client: GatewayBrowserClient,
    gateway: ApplicationGateway,
    private readonly changed: () => void,
    private readonly isCurrent: () => boolean,
    private readonly legacyRetired: (dismissals: SidebarAttentionDismissals) => void,
  ) {
    const profileId = gateway.snapshot.selfUser?.id;
    this.#stopPreferences = gateway.subscribeEvents((event) => {
      if (
        event.event === "users.prefs.changed" &&
        isRecord(event.payload) &&
        event.payload.profileId === profileId &&
        Array.isArray(event.payload.keys) &&
        event.payload.keys.includes(CRON_FAILURE_DISMISSALS_KEY)
      ) {
        void this.refresh();
      }
    });
    const storage = getSafeLocalStorage();
    const prefix = this.#deferredKey("");
    if (!storage) {
      return;
    }
    try {
      for (let index = 0; index < storage.length; index++) {
        const pendingKey = storage.key(index);
        if (pendingKey?.startsWith(prefix)) {
          const at = Number(storage.getItem(pendingKey));
          if (Number.isSafeInteger(at) && at >= 0) {
            this.#deferred.set(pendingKey.slice(prefix.length), at);
          }
        }
      }
    } catch {
      // Gateway receipts remain available if the browser denies storage.
    }
  }

  #deferredKey(id: string) {
    return deferredCronFailurePrefix(this.key) + id;
  }

  hidden(id: string, at: number, legacy?: readonly string[]): boolean {
    const receipt = this.#receipts.get(id);
    return (
      !this.#loaded ||
      this.#pending.get(id) === at ||
      this.#deferred.get(id) === at ||
      (receipt === undefined ? legacy?.includes(id) === true : receipt >= at)
    );
  }

  load(): void {
    if (!this.#loaded && !this.#reading) {
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    globalThis.clearTimeout(this.#retry);
    this.#reading = true;
    try {
      const response = await this.client.request<UsersPrefsGetResult>("users.prefs.get", {
        keys: [CRON_FAILURE_DISMISSALS_KEY],
      });
      if (!this.#disposed && response.status === "ok") {
        for (const [id, at] of readCronFailureDismissals(
          response.entries[CRON_FAILURE_DISMISSALS_KEY],
        )) {
          this.#remember(id, at);
        }
      }
    } catch {
      // Keep known receipts across transient read failures; retry even on an idle gateway.
      if (!this.#disposed && this.isCurrent()) {
        this.#retry = globalThis.setTimeout(() => void this.refresh(), 60_000);
      }
    } finally {
      this.#reading = false;
      this.#loaded = true;
      if (!this.#disposed) {
        this.changed();
        if (this.#readAgain) {
          this.#readAgain = false;
          void this.refresh();
        }
      }
    }
  }

  #remember(id: string, at: number) {
    this.#receipts.set(id, Math.max(this.#receipts.get(id) ?? 0, at));
  }

  #defer(id: string, at: number): void {
    // Keep the exact reviewed run through a same-profile reconnect. Different jobs
    // have independent keys, so offline tabs cannot replace each other's intent.
    this.#deferred.set(id, at);
    try {
      const storage = getSafeLocalStorage();
      if (!storage) {
        throw new Error(t("connection.offlineChangesReloadBlocked"));
      }
      storage.setItem(this.#deferredKey(id), String(at));
    } catch (error) {
      showToast({ severity: "error", message: formatUiError(error) });
    }
  }

  async acknowledge(id: string, at?: number): Promise<void> {
    if (this.#disposed || (at !== undefined && this.#pending.get(id) === at)) {
      return;
    }
    if (at !== undefined && !this.isCurrent()) {
      this.#defer(id, at);
      this.changed();
      return;
    }
    if (at !== undefined) {
      this.#pending.set(id, at);
      this.changed();
    }
    try {
      const result = await this.client.request<{ acknowledgedAtMs: number | null }>(
        "cron.acknowledgeFailure",
        at === undefined ? { id, adopt: true } : { id, failedAtMs: at },
      );
      if (!this.#disposed) {
        if (typeof result.acknowledgedAtMs === "number") {
          this.#remember(id, result.acknowledgedAtMs);
          if (at === undefined) {
            this.legacyRetired(retireLegacyCronDismissal(this.key, id));
          }
        }
        if (this.#deferred.get(id) === at && at !== undefined) {
          this.#deferred.delete(id);
          const storage = getSafeLocalStorage();
          if (storage?.getItem(this.#deferredKey(id)) === String(at)) {
            storage.removeItem(this.#deferredKey(id));
          }
        }
      }
    } catch (error) {
      if (at !== undefined && !this.#disposed) {
        if (isGatewayRestartUnavailableError(error)) {
          if (this.#pending.get(id) === at) {
            this.#defer(id, at);
          }
        } else {
          showToast({ message: formatUiError(error), severity: "error" });
        }
      }
    } finally {
      if (at !== undefined && this.#pending.get(id) === at) {
        this.#pending.delete(id);
      }
      if (!this.#disposed) {
        this.changed();
      }
    }
  }

  adopt(ids?: readonly string[]): void {
    for (const id of [...(ids ?? []), ...this.#deferred.keys()]) {
      this.#imports.add(id);
    }
    if (!this.#imports.size || this.#adopting) {
      return;
    }
    // v2 stored only job IDs. The gateway resolves their current failure, including
    // paused jobs and jobs outside this tab's selected agent, without overwriting a receipt.
    this.#adopting = true;
    void (async () => {
      try {
        for (const id of this.#imports) {
          if (this.#disposed || !this.isCurrent()) {
            break;
          }
          await this.acknowledge(id, this.#deferred.get(id));
          this.#imports.delete(id);
        }
      } finally {
        this.#adopting = false;
      }
    })();
  }

  dispose(): void {
    this.#disposed = true;
    this.#stopPreferences();
    globalThis.clearTimeout(this.#retry);
  }
}
