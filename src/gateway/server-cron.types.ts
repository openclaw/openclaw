// Leaf contracts shared by the Gateway cron runtime, lazy loader, and request contexts.
import type { CronServiceContract } from "../cron/service-contract.js";

export type GatewayCronServiceContract = CronServiceContract & {
  /** Temporarily disarm ticks without running startup recovery on resume. */
  pauseScheduling(): void;
  resumeScheduling(): void;
  /** Scheduler-owned work not represented by active cron run markers. */
  getSuspensionBlockerCount?(): number;
};

export type GatewayCronState = {
  cron: GatewayCronServiceContract;
  storePath: string;
  cronEnabled: boolean;
  reconcileExitWatchers?: () => Promise<void>;
  stopExitWatchers?: () => void;
};
