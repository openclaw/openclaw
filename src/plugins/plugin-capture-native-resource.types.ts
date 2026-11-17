import type { NativeWorkerFailure } from "../infra/worker-native-error.js";
import type { PluginSourceCaptureStorage } from "./plugin-instance-invocation.types.js";
export const PLUGIN_CAPTURE_RESOURCE_PORT = "pluginCaptureResourcePort";
export type PluginCaptureResourceInput = { owner: string; role: "owner" | "execution" };
export type PluginCaptureResourceCommand =
  | {
      type: "source";
      captureId: number;
      storage: PluginSourceCaptureStorage;
      prefix: string;
    }
  | { type: "native"; captureId: number; storage: PluginSourceCaptureStorage }
  | { type: "release-source"; captureId: number }
  | { type: "commit-native" | "release-native"; rootId: number }
  | { type: "loaded"; filename: string };
export type PluginCaptureResourceRequest = { id: number; command: PluginCaptureResourceCommand };
export type PluginCaptureResourceRoot = { id: number; directory: string; managedRoot?: string };
export type PluginCaptureResourceReply =
  | {
      id: number;
      ok: true;
      root?: PluginCaptureResourceRoot;
      retainBrokerUntilProcessExit?: boolean;
    }
  | { id: number; ok: false; error: NativeWorkerFailure };
export type PluginCaptureRootAnnouncement = { captureId: number; root: PluginCaptureResourceRoot };
