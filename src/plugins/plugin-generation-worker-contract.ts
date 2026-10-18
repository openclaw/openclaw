import type { MessagePort } from "node:worker_threads";
import type { PluginInstallRoots } from "./install-root-context.js";
import type { GenerationWireValue } from "./plugin-generation-worker-codec.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
import type { AdmissionState } from "./plugin-native-admission-state.js";
import type { PluginSourceAdmissionPublication } from "./plugin-source-admission.types.js";

export type GenerationWorkerInput = (
  | {
      operation: "capture";
      captureId: number;
      rootDir: string;
      entryFile?: string;
      storage: PluginSourceCaptureStorage;
      installRoots: PluginInstallRoots;
      readOnly: boolean;
      scratch: string;
      managedRoot?: string;
      admission: Pick<
        AdmissionState,
        "owners" | "managedRoots" | "receipts" | "files" | "namespaces"
      >;
      callbackPort?: MessagePort;
    }
  | { operation: "call"; handle: number; args: GenerationWireValue[]; asynchronous: boolean }
  | { operation: "close" }
) & { nativeLoads?: string[] };
export type GenerationWorkerReply = (
  | { value: GenerationWireValue; resources: number; admission?: GenerationWireValue }
  | { error: { message: string; name: string; stack?: string }; resources: number }
) & { released?: number[] };
export type GenerationWorkerCallback =
  | { kind: "publish"; id: number; publication: PluginSourceAdmissionPublication }
  | { kind: "published"; id: number; accepted?: boolean; error?: string }
  | { kind: "mapping"; id: number; captureId: number; filename: string; signal: Int32Array }
  | { kind: "mapped"; id: number; filename?: string; error?: string }
  | { kind: "native-load"; filename: string };
