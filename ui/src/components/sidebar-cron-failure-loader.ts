import type { ApplicationGateway } from "../app/gateway.ts";
import { hasOperatorReadAccess } from "../app/operator-access.ts";
import { isGatewayAvailable } from "../lib/gateway-availability.ts";
import {
  resolveSidebarAttentionKey,
  type SidebarAttentionDismissals,
} from "./sidebar-attention-dismissals.ts";
import type { CronFailureDismissals } from "./sidebar-cron-failure-dismissals.ts";

/** Owns the lifetime of the lazy per-profile failure receipts. */
export class SidebarCronFailureLoader {
  #owner: CronFailureDismissals | null = null;
  #loadFailed = false;
  #disposed = false;

  constructor(
    private readonly gateway: ApplicationGateway,
    private readonly onChange: () => void,
    private readonly legacyIds: () => readonly string[] | undefined,
    private readonly legacyRetired: (dismissals: SidebarAttentionDismissals) => void,
  ) {}

  get owner() {
    return this.#owner;
  }

  get loadFailed() {
    return this.#loadFailed;
  }

  synchronize(key: string | null, identityChanged: boolean): void {
    if (
      this.#owner &&
      (this.#owner.key !== key || this.#owner.client !== this.gateway.snapshot.client)
    ) {
      this.#owner.dispose();
      this.#owner = null;
    }
    if (identityChanged) {
      this.#loadFailed = false;
    }
  }

  async load(key: string | null): Promise<CronFailureDismissals | null> {
    if (this.#owner) {
      this.#owner.load();
      return this.#owner;
    }
    const client = this.gateway.snapshot.client;
    if (!key || !client) {
      return null;
    }
    const isCurrent = () =>
      !this.#disposed &&
      this.gateway.snapshot.client === client &&
      resolveSidebarAttentionKey(this.gateway) === key;
    try {
      // The normal boot path has no failed jobs or migration work.
      const { CronFailureDismissals } = await import("./sidebar-cron-failure-dismissals.ts");
      const snapshot = this.gateway.snapshot;
      if (
        !isCurrent() ||
        !isGatewayAvailable(snapshot) ||
        !hasOperatorReadAccess(snapshot.hello?.auth ?? null)
      ) {
        return null;
      }
      if (!this.#owner) {
        this.#owner = new CronFailureDismissals(
          key,
          client,
          this.gateway,
          this.onChange,
          isCurrent,
          this.legacyRetired,
        );
        this.#owner.adopt(this.legacyIds());
        this.#owner.load();
      }
      return this.#owner;
    } catch {
      // Render failures when the chunk is unavailable. The next refresh or dismissal retries.
      if (isCurrent() && !this.#loadFailed) {
        this.#loadFailed = true;
        this.onChange();
      }
      return null;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#owner?.dispose();
  }
}
