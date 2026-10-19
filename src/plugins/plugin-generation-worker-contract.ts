import type { MessagePort } from "node:worker_threads";
import type { JitiOptions } from "jiti";
import type { PluginInstallRoots } from "./install-root-context.js";
import type { PluginGenerationCaptureState } from "./plugin-generation-capture.types.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import type {
  AdmissionState,
  PluginNativeAdmissionTransfer,
} from "./plugin-native-admission-state.js";

export type GenerationWorkerInput = {
  operation: "capture";
  rootDir: string;
  entryFile?: string;
  storage: PluginSourceCaptureStorage;
  installRoots: PluginInstallRoots;
  readOnly: boolean;
  sourceCapture: { directory: string; outputRoot?: string };
  admission: Pick<AdmissionState, "owners" | "managedRoots" | "receipts" | "files" | "namespaces">;
  callbackPort: MessagePort;
};
export type GenerationWorkerReply =
  | {
      state: PluginGenerationCaptureState;
      admission: Omit<PluginNativeAdmissionTransfer, "roots"> & { roots: number[] };
    }
  | { error: { message: string; name: string; stack?: string } };

export type GenerationWorkerCallback =
  | { kind: "resolution-policy"; id: number; source: string; signal: Int32Array }
  | {
      kind: "resolve";
      id: number;
      source: string;
      reference: string;
      conditions: readonly string[];
      signal: Int32Array;
    }
  | { kind: "native-root"; id: number; signal: Int32Array }
  | {
      kind: "callback-result";
      id: number;
      options?: Omit<JitiOptions, "transform">;
      resolved?: string;
      root?: { id: number; directory: string };
      error?: { message: string; name: string; stack?: string };
    };
