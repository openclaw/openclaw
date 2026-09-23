import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { NodePairingGeneration } from "./device-pairing-identity.js";
import type {
  ApproveNodePairingResult,
  NodePairingPendingSnapshot,
  NodePairingRequestInput,
  NodePairingSupersededRequest,
  PairedDeviceNode,
  RecordPairedNodeConnectionResult,
  RequestNodePairingResult,
} from "./device-pairing-node.records.js";

type GenerationInput = { nodeId: string; expectedPairingGeneration: NodePairingGeneration };

export type DevicePairingNodeWorkerOperations = {
  "node.request": {
    input: { req: NodePairingRequestInput; nowMs: number };
    output: RequestNodePairingResult;
  };
  "node.finalizeCleanup": {
    input: { observed: NodePairingPendingSnapshot };
    output: NodePairingSupersededRequest[];
  };
  "node.approve": {
    input: { requestId: string; callerScopes?: readonly string[]; nowMs: number };
    output: ApproveNodePairingResult;
  };
  "node.reject": {
    input: { requestId: string };
    output: { requestId: string; nodeId: string } | null;
  };
  "node.recordConnection": {
    input: {
      nodeId: string;
      connectedAtMs: number;
      expectedPairingGeneration?: NodePairingGeneration;
    };
    output: RecordPairedNodeConnectionResult;
  };
  "node.recordDisconnection": {
    input: GenerationInput & { connectedAtMs: number; disconnectedAtMs: number };
    output: boolean;
  };
  "node.recordHostStats": {
    input: GenerationInput & { hostStats: NodeHostStats };
    output: boolean;
  };
  "node.updateBins": { input: GenerationInput & { bins: string[] }; output: boolean };
  "node.updateSessionHost": { input: GenerationInput & { sessionHost: boolean }; output: boolean };
  "node.rename": {
    input: { nodeId: string; displayName: string };
    output: PairedDeviceNode | null;
  };
};

export type DevicePairingNodeMutation = {
  [Key in keyof DevicePairingNodeWorkerOperations]: {
    type: Key;
    input: DevicePairingNodeWorkerOperations[Key]["input"];
  };
}[keyof DevicePairingNodeWorkerOperations];

export type DevicePairingNodeAdmissionFacts =
  | ({ kind: "node-pending" } & NodePairingPendingSnapshot)
  | { kind: "node-surface"; nodeId: string; pairingGeneration?: string };
