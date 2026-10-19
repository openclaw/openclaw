import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { channelIngressOperations } from "./ingress-queue.worker.js";

export type ChannelIngressWorkerOperations = WorkerOperations<typeof channelIngressOperations>;
