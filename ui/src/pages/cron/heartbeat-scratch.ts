import type { CronScratchGetResult } from "../../api/types.ts";
import type { CronState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";

type CronHeartbeatScratchHost = {
  currentCronState: () => CronState;
  canManage: () => boolean;
  captureConnection: () => GatewayConnectionScope | null;
  isCurrentConnection: (scope: GatewayConnectionScope) => boolean;
  notify: (cronState: CronState) => void;
};

export class CronHeartbeatScratchController {
  content = "";
  private requestId = 0;

  constructor(private readonly host: CronHeartbeatScratchHost) {}

  reset() {
    this.requestId += 1;
    if (this.content !== "") {
      this.content = "";
      this.host.notify(this.host.currentCronState());
    }
  }

  async load(cronState: CronState, jobId: string) {
    const requestId = this.requestId;
    const client = cronState.client;
    if (!this.host.canManage() || !client || !cronState.connected) {
      return;
    }
    const connectionScope = this.host.captureConnection();
    if (!connectionScope) {
      return;
    }
    // Scratch is admin-only and selection-owned. Revalidate every owner after
    // the request so a stale response cannot survive a scope or panel change.
    const isCurrent = () =>
      this.host.currentCronState() === cronState &&
      this.requestId === requestId &&
      this.host.isCurrentConnection(connectionScope) &&
      this.host.canManage() &&
      cronState.cronEditingJob?.id === jobId &&
      cronState.cronForm.payloadKind === "heartbeat";
    try {
      const result = await client.request<CronScratchGetResult>("cron.scratch.get", { id: jobId });
      if (isCurrent()) {
        const content = result.scratch?.content ?? "";
        if (this.content !== content) {
          this.content = content;
          this.host.notify(cronState);
        }
      }
    } catch (error) {
      if (isCurrent()) {
        cronState.cronError = formatUiError(error);
        this.host.notify(cronState);
      }
    }
  }
}
