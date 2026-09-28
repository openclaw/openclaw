import type { NodeWorkerCleanupBinding } from "../../node-host/node-worker-launch-receipt.js";

export type ServiceChildStart = {
  type: "start";
  generation: string;
  command: string;
  args: string[];
  argv0?: string;
  cwd?: string;
  env?: Record<string, string>;
  stdinMode: "inherit" | "pipe-open" | "pipe-closed";
  secretFd?: number;
  controlFd?: number;
  /** Host-owned lineage writer; absent for older hosts retained by update --no-restart. */
  lineageFd?: number;
  /** Keeps an enclosing worker owned until this command's cleanup completes. */
  parentLineageFds?: number[];
  /** Absent only for older Gateway hosts retained by update --no-restart. */
  acknowledgeClosing?: true;
  windowsShellCommand?: string;
} & (
  | { ownedWorker: true; cleanupBinding: NodeWorkerCleanupBinding }
  | { ownedWorker?: never; cleanupBinding?: never }
);

export type ServiceChildControlMessage = {
  generation: string;
  sequence: number;
} & (
  | { type: "cancel"; signal: "SIGTERM" | "SIGKILL" }
  | { type: "worker-start" }
  | { type: "worker-close" }
  | { type: "startup-error-ack" }
  | { type: "lineage-closed" }
  | { type: "closing-ack"; closingSequence: number }
);

export type ServiceChildAnchorPayload =
  | { type: "stdin-closed" }
  | { type: "worker-message"; message: unknown }
  | {
      type: "ready";
      commandPid: number;
      anchorPid: number;
    }
  | {
      type: "root-result";
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | {
      type: "result-error";
      error: string;
    }
  | {
      type: "output";
      stream: "stdout" | "stderr";
      chunk: string;
    }
  | {
      type: "output-end";
      stream: "stdout" | "stderr";
    }
  | {
      type: "closing";
      reason: "cancel" | "lineage-closed" | "lineage-lost" | "parent-lost";
    }
  | {
      type: "startup-error";
      error: string;
    };

export type ServiceChildAnchorMessage = ServiceChildAnchorPayload & {
  generation: string;
  sequence: number;
};

export type ServiceChildRelayRetirement = {
  type: "retirement";
  generation: string;
  sequence: number;
  anchorExited: boolean;
  signalError?: string;
};

export type ServiceChildRelayMessage =
  | ServiceChildStart
  | ServiceChildRelayRetirement
  | { type: "relay-error"; generation: string; error: string };

export function encodeServiceChildMessage(
  message: ServiceChildStart | ServiceChildControlMessage | ServiceChildAnchorMessage,
): string {
  return `${JSON.stringify(message)}\n`;
}

export function supportsNodeWorkerProcessOwner(platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}
