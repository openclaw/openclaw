import type { ChildProcess } from "node:child_process";
import type { NodeWorkerCleanupBinding } from "../../node-host/node-worker-launch-receipt.js";

export type ServiceChildStart = {
  type: "start" | "prepare";
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
  treeOwnership?: "linux-subreaper";
  /** Package-owned helper inherited by an admitted portable worker, never a remote command. */
  nativeProcessOwner?: string;
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
  | { type: "launch" }
  | { type: "worker-close" }
  | { type: "startup-error-ack" }
  | { type: "lineage-closed" }
  | { type: "closing-ack"; closingSequence: number }
);

export type ServiceChildAnchorPayload =
  | { type: "prepared" }
  | { type: "stdin-closed" }
  | { type: "worker-message"; message: unknown }
  | {
      type: "ready";
      commandPid: number;
      anchorPid: number;
      treeOwnership?: "linux-subreaper";
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
      descendantsReaped?: true;
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

export function readServiceChildMessage(
  raw: unknown,
): ServiceChildRelayMessage | ServiceChildAnchorMessage {
  // SAFETY: the spawned relay or Job anchor is the sole writer on each private protocol channel.
  return raw as ServiceChildRelayMessage | ServiceChildAnchorMessage;
}

/** The retained private IPC peer owns delivery acknowledgement for these frames. */
export function sendServiceChildMessage(
  child: Pick<ChildProcess, "connected" | "send">,
  message: ServiceChildStart | ServiceChildControlMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("service child lifecycle IPC is closed"));
      return;
    }
    child.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export function encodeServiceChildMessage(
  message: ServiceChildStart | ServiceChildControlMessage | ServiceChildAnchorMessage,
): string {
  return `${JSON.stringify(message)}\n`;
}

export function supportsNodeWorkerProcessOwner(platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}
