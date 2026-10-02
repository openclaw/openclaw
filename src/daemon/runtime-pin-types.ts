/** Dependency-free runtime intent contracts shared by planners and native service writers. */
type DaemonRuntimePin = { runtime: "node" | "bun"; path: string };

export type DaemonRuntimePinSnapshot = {
  revision: string;
  stored: boolean;
  definition?: string;
  pin?: DaemonRuntimePin;
};

export type DaemonRuntimePinUpdate = { expected: DaemonRuntimePinSnapshot; pin?: DaemonRuntimePin };
