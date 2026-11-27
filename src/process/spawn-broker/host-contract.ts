import type { createBrokerCommands } from "./commands.js";
import type { BrokerFileReads } from "./file-reads.js";
import type {
  BrokerNativeResourceCallbacks,
  BrokerNativeResourceInput,
  BrokerNativeResourceLease,
} from "./resource-host.js";

export type SpawnBrokerHostOptions = {
  onReady?: (pid: number, restarted: boolean) => void;
  onClosed?: () => void;
  workerUrl?: URL;
  nativeResources?: true;
};

/** Host operations available without importing its runtime diagnosis or startup. */
export interface AttachmentBrokerHost {
  readonly entryPath: string;
  readonly pid: number | undefined;
  readonly hasOpenNativeResourceClaims: boolean;
  readonly nativeResourceAdmissionClosed: boolean;
  ready(): Promise<void>;
  captureNativeResource(
    input: BrokerNativeResourceInput,
    callbacks: BrokerNativeResourceCallbacks,
  ): BrokerNativeResourceLease;
  sealNativeResources(): Promise<void>;
  serviceNativeResources(): void;
  waitForCleanup(): Promise<void>;
  close(): Promise<void>;
}

export interface SpawnBrokerHost
  extends AttachmentBrokerHost, ReturnType<typeof createBrokerCommands> {
  readFile(filePath: string, signal?: AbortSignal): Promise<Buffer>;
  readonly readFilePage: BrokerFileReads["readPage"];
}
