import type { MessagePort, Worker, WorkerOptions, Transferable } from "node:worker_threads";
import type { SpawnBrokerHost } from "../process/spawn-broker/host.js";
import type {
  BrokerResourceAttachment,
  BrokerResourceResponse,
} from "../process/spawn-broker/resource-protocol.js";
import type { captureSqliteWorkerEnvironmentData } from "./bun-sqlite-library.js";
import type { NativeWorkerFailure } from "./worker-native-error.js";

export type { NativeWorkerEvents, RetainedNativeWorker } from "@openclaw/worker-runtime/lifecycle";

/** Handle operations consume this owner contract without importing its controller. */
export type NativeWorkerRuntime = {
  handles: { delete(id: number): boolean };
  failure?: Error;
  service(): void;
  post(message: NativeWorkerRequest, transfers?: readonly Transferable[]): void;
  refreshReference(): void;
  resourceBroker(): SpawnBrokerHost;
};

type NativeWorkerOptions = Omit<WorkerOptions, "env" | "transferList"> & {
  environment: NodeJS.ProcessEnv;
  shareEnvironment: boolean;
};

/** Captured with the execution source before its admission queue can yield. */
export type NativeWorkerResourceDescriptor = Readonly<{
  moduleUrl: string;
  workerDataKey: string;
  input?: unknown;
  connect?: () => NativeWorkerResourceConnection;
}>;

/** The existing domain owner retains its counterpart and authoritative reader fences. */
export type NativeWorkerResourceConnection = {
  port: MessagePort;
  service(): void;
  dispose(): void;
  decodeCloseError?: (payload: unknown) => Error;
};

type NativeWorkerResourceRequest = {
  workerDataKey: string;
  attachment: BrokerResourceAttachment;
};

/** The original resource owner joins its native children before physical retirement. */
export type NativeWorkerResourceOwner = {
  close(): Promise<void>;
  encodeCloseError?: (error: unknown) => unknown;
};

/** The resource owner exchanges plain messages; the host retains its real polling port. */
export interface NativeWorkerResourcePort {
  on(event: "message", listener: (value: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "messageerror", listener: (error: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
  postMessage(value: unknown): void;
  close(): void;
}

export type NativeWorkerResourceModule = {
  createNativeWorkerResource(
    port: NativeWorkerResourcePort,
    input: unknown,
    ownerPort?: NativeWorkerResourcePort,
  ): NativeWorkerResourceOwner;
};

export type NativeWorkerRequest =
  | {
      type: "create";
      id: number;
      filename: { kind: "url" | "path"; value: string };
      environmentData: ReturnType<typeof captureSqliteWorkerEnvironmentData>;
      options: NativeWorkerOptions;
      transferList: Transferable[];
      resource?: NativeWorkerResourceRequest;
    }
  | { type: "post"; id: number; value: unknown; transferList: Transferable[] }
  | { type: "resource-owner"; id: number; sequence: number; value: unknown }
  | { type: "stop" | "release"; id: number }
  | { type: "ref"; id: number; referenced: boolean }
  | { type: "cpu"; id: number; requestId: number; previous?: NodeJS.CpuUsage }
  | { type: "heap"; id: number; requestId: number };

export type NativeWorkerReply =
  | { type: "created"; id: number; threadId: number }
  | { type: "message"; id: number; value: unknown }
  | { type: "resource-message"; id: number; response: BrokerResourceResponse }
  | { type: "error" | "messageerror" | "create-error"; id: number; error: NativeWorkerFailure }
  | { type: "stopped"; id: number; code: number }
  | { type: "execution-exit"; id: number; code: number }
  | { type: "stop-error"; id: number; error: NativeWorkerFailure; resourceError?: false }
  | { type: "stop-error"; id: number; error: unknown; resourceError: true }
  | { type: "cpu"; id: number; requestId: number; value: NodeJS.CpuUsage }
  | {
      type: "heap";
      id: number;
      requestId: number;
      value: Awaited<ReturnType<Worker["getHeapStatistics"]>>;
    }
  | { type: "request-error"; id: number; requestId: number; error: NativeWorkerFailure };
