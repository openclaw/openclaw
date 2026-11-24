export type PluginNativeCaptureRoot = {
  directory: string;
  commit(): void | Promise<void>;
  dispose(): void;
  disposeAsync(): Promise<void>;
};
