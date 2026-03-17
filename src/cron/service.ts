import * as ops from "./service/ops.js";
import type { CronMutationCallerOptions } from "./service/ops.js";
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

  async update(id: string, patch: CronJobPatch, caller?: CronMutationCallerOptions) {
    return await ops.update(this.state, id, patch, caller);
  }

  async remove(id: string, caller?: CronMutationCallerOptions) {
    return await ops.remove(this.state, id, caller);
  }

  async run(id: string, mode?: "due" | "force", caller?: CronMutationCallerOptions) {
    return await ops.run(this.state, id, mode, caller);
  }

  async enqueueRun(id: string, mode?: "due" | "force", caller?: CronMutationCallerOptions) {
    return await ops.enqueueRun(this.state, id, mode, caller);
  }

  getJob(id: string): CronJob | undefined {
    return this.state.store?.jobs.find((job) => job.id === id);
  }

  wake(opts: { mode: "now" | "next-heartbeat"; text: string }) {
    return ops.wakeNow(this.state, opts);
  }
}
