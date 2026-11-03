import type { MessagePort } from "node:worker_threads";
import type { PluginInstallRoots } from "./install-root-context.js";
import type { PluginGenerationMetrics } from "./plugin-generation-metrics.js";
import type { GenerationWireValue } from "./plugin-generation-worker-codec.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import type { AdmissionState } from "./plugin-native-admission-state.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";

export type PluginGenerationInspection =
  | {
      kind: "dependencies";
      entries: readonly { rootDir: string; entryFile: string }[];
      dependencyRoot?: string;
    }
  | {
      kind: "sources";
      entries: readonly { pluginId: string; rootDir: string; entryFile?: string }[];
    };

export type GenerationWorkerInput = (
  | {
      operation: "capture";
      captureId: number;
      rootDir: string;
      entryFile?: string | readonly string[];
      storage: PluginSourceCaptureStorage;
      installRoots: PluginInstallRoots;
      readOnly: boolean;
      scratch: string;
      managedRoot?: string;
      inspection?: PluginGenerationInspection;
      sourceSnapshot?: { descriptor: PluginSourceSnapshotDescriptor; stateDir: string };
      snapshotPublication?: { stateDir: string };
      admission: Pick<
        AdmissionState,
        "owners" | "managedRoots" | "receipts" | "files" | "namespaces"
      >;
      callbackPort?: MessagePort;
      progressSignal?: Int32Array<SharedArrayBuffer>;
    }
  | {
      operation: "call";
      captureId: number;
      handle: number;
      args: GenerationWireValue[];
      asynchronous: boolean;
    }
) & { nativeLoads?: string[] };
export type GenerationWorkerReply = (
  | { value: GenerationWireValue; resources: number; admission?: GenerationWireValue }
  | {
      error: {
        message: string;
        name: string;
        stack?: string;
        code?: string;
        artifactPath?: string;
        modulePath?: string;
      };
      sourceAcquisitionFailure?: true;
      resources: number;
    }
) & { released?: number[]; metrics?: PluginGenerationMetrics };
export type GenerationWorkerCallback =
  | { kind: "mapping"; id: number; captureId: number; filename: string; signal: Int32Array }
  | { kind: "native-root"; id: number; signal: Int32Array }
  | {
      kind: "callback-result";
      id: number;
      filename?: string;
      root?: { id: number; directory: string };
      error?: string;
    }
  | { kind: "native-load"; filename: string };
