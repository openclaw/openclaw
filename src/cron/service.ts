import * as ops from "./service/ops.js";
import { type CronServiceDeps, createCronServiceState } from "./service/state.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "./types.js";

export type { CronEvent, CronServiceDeps } from "./service/state.js";

export class CronService {
  private readonly state;
  constructor(deps: CronServiceDeps) {
    this.state = createCronServiceState(deps);
  }

  async start() {
    await ops.start(this.state);
  }

  stop() {
    ops.stop(this.state);
  }

  async status() {
    return await ops.status(this.state);
  }

  async list(opts?: { includeDisabled?: boolean }) {
    return await ops.list(this.state, opts);
  }

  async listPage(opts?: ops.CronListPageOptions) {
    return await ops.listPage(this.state, opts);
  }

  async add(input: CronJobCreate) {
    return await ops.add(this.state, input);
  }

  async update(id: string, patch: CronJobPatch) {
    return await ops.update(this.state, id, patch);
  }

  async remove(id: string) {
    return await ops.remove(this.state, id);
  }

  async run(id: string, mode?: "due" | "force") {
    return await ops.run(this.state, id, mode);
  }

  getJob(id: string): CronJob | undefined {
    const jobs = this.state.store?.jobs ?? [];
    // Try exact match first
    const exact = jobs.find((job) => job.id === id);
    if (exact) {
      return exact;
    }
    // Try prefix match (e.g., "0ed3cd30" matches "0ed3cd30-00a1-...")
    const matches = jobs.filter((job) => job.id.startsWith(id));
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous cron job ID "${id}": ${matches.map((j) => j.id).join(", ")}`);
    }
    return undefined;
  }

  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
