import type { createBrokerCommands } from "./commands.js";
import type { BrokerFileReads } from "./file-reads.js";
import type {
  BrokerNativeResourceCallbacks,
  BrokerNativeResourceInput,
  BrokerNativeResourceLease,
} from "./resource-host.js";

/** Host operations available without importing its runtime diagnosis or startup. */
export interface SpawnBrokerHost extends ReturnType<typeof createBrokerCommands> {
  readonly entryPath: string;
  readonly pid: number | undefined;
  readonly hasOpenNativeResourceClaims: boolean;
  readonly nativeResourceAdmissionClosed: boolean;
  ready(): Promise<void>;
  readFile(filePath: string, signal?: AbortSignal): Promise<Buffer>;
  readonly readFilePage: BrokerFileReads["readPage"];
  captureNativeResource(
    input: BrokerNativeResourceInput,
    callbacks: BrokerNativeResourceCallbacks,
  ): BrokerNativeResourceLease;
  sealNativeResources(): Promise<void>;
  serviceNativeResources(): void;
  waitForCleanup(): Promise<void>;
  close(): Promise<void>;
}
