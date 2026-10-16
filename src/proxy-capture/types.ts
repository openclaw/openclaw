import type { z } from "zod";
import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  debugProxyCaptureWriteCommandSchema,
  debugProxyCliCommandSchema,
} from "./cli-contract.js";

// Shared debug-proxy capture schema. These records back the SQLite store, CLI
// reports, and runtime capture events for HTTP/SSE/websocket traffic.
type CaptureWriteCommand = z.input<typeof debugProxyCaptureWriteCommandSchema>;
type CaptureCliCommand = z.input<typeof debugProxyCliCommandSchema>;
export type CaptureProtocol = CaptureEventRecord["protocol"];

export type CaptureDirection = CaptureEventRecord["direction"];

export type CaptureEventKind = CaptureEventRecord["kind"];

export type CaptureSessionRecord = {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: string;
  sourceScope: "openclaw";
  sourceProcess: string;
  proxyUrl?: string;
  /** @deprecated Capture storage now lives in the shared state database. */
  dbPath?: string;
  /** @deprecated Capture payloads now live in the shared state database. */
  blobDir?: string;
};

export type CaptureBlobRecord = {
  blobId: string;
  path: string;
  encoding: "gzip";
  sizeBytes: number;
  sha256: string;
  contentType?: string;
};

export type SharedCaptureBlobRecord = Omit<CaptureBlobRecord, "path"> & {
  path?: never;
};

export type CaptureEventRecord = SchemaContract<
  Extract<CaptureWriteCommand, { type: "capture.recordEvent" }>["input"]
>;

export type CaptureQueryPreset = Extract<
  CaptureCliCommand,
  { type: "capture.queryPreset" }
>["input"]["preset"];

export type CaptureQueryRow = Record<string, string | number | null>;

export type CaptureSessionSummary = {
  id: string;
  startedAt: number;
  endedAt?: number;
  mode: string;
  sourceProcess: string;
  proxyUrl?: string;
  eventCount: number;
};

export type CaptureObservedDimension = {
  value: string;
  count: number;
};

export type CaptureSessionCoverageSummary = {
  sessionId: string;
  totalEvents: number;
  unlabeledEventCount: number;
  providers: CaptureObservedDimension[];
  apis: CaptureObservedDimension[];
  models: CaptureObservedDimension[];
  hosts: CaptureObservedDimension[];
  localPeers: CaptureObservedDimension[];
};
