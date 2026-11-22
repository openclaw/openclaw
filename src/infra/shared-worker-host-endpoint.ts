import { AsyncLocalStorage } from "node:async_hooks";
import { workerData, type MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** One logical endpoint inside the shared worker host isolate. */
export type HostedWorkerEndpoint = {
  readonly port: MessagePort;
  readonly workerData: unknown;
  /** Retained-transport pools wait for a ready acknowledgement on the endpoint port. */
  readonly ready: boolean;
  /** Set by the served module; the host runs it once for a graceful logical stop. */
  close?: () => void | Promise<void>;
  /** Isolate state became untrusted; the main thread replaces the whole host. */
  fail(reason: string): void;
  /** Standalone workers keep this channel isolate-global; hosted endpoints keep their own. */
  admissionUpstream?: { port: MessagePort; closed: boolean };
};

/** Starts one endpoint; standalone isolates already started their only server at import. */
export type HostedWorkerStart = (endpoint: HostedWorkerEndpoint) => void;

const endpointScope = resolveGlobalSingleton(
  Symbol.for("openclaw.sharedWorkerHostEndpoint"),
  () => new AsyncLocalStorage<HostedWorkerEndpoint>(),
);

/** Hosted entry modules defer serving until the host attaches an endpoint. */
export function isSharedWorkerHostIsolate(): boolean {
  return isRecord(workerData) && workerData.sharedWorkerHost === true;
}

export function runInHostedWorkerEndpoint<T>(endpoint: HostedWorkerEndpoint, run: () => T): T {
  return endpointScope.run(endpoint, run);
}

export function currentHostedWorkerEndpoint(): HostedWorkerEndpoint | undefined {
  return endpointScope.getStore();
}
