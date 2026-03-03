import * as ops from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
export class CronService {
    state;
    constructor(deps) {
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
    async list(opts) {
        return await ops.list(this.state, opts);
    }
    async listPage(opts) {
        return await ops.listPage(this.state, opts);
    }
    async add(input) {
        return await ops.add(this.state, input);
    }
    async update(id, patch) {
        return await ops.update(this.state, id, patch);
    }
    async remove(id) {
        return await ops.remove(this.state, id);
    }
    async run(id, mode) {
        return await ops.run(this.state, id, mode);
    }
    getJob(id) {
        return this.state.store?.jobs.find((job) => job.id === id);
    }
    wake(opts) {
        return ops.wakeNow(this.state, opts);
    }
}
