import type { Writable } from "node:stream";
import { resolveRuntimeProcessEntrypointUrl } from "../../infra/runtime-process-url.js";
import type { NodeWorkerCleanupBinding } from "../../node-host/node-worker-launch-receipt.js";
import { prepareSecretInputStdio, type SpawnStdioEntry } from "../spawn-secret-input.js";
import { getInheritedProcessLineageFds } from "./inherited-process-lineage.js";
import { supportsNodeWorkerProcessOwner } from "./service-child-protocol.js";
import type { ProcessAdapterConstruction, SpawnSecretInput } from "./types.js";

export type ServiceChildRelayParams = ProcessAdapterConstruction & {
  command: string;
  args: string[];
  argv0?: string;
  cwd?: string;
  stdinMode: "inherit" | "pipe-open" | "pipe-closed";
  input?: string;
  secretInput?: SpawnSecretInput;
  stderrDestination?: Writable;
  stdoutConsumption?: "awaited";
  oomScoreWrapperSelected: boolean;
  onWorkerMessage?: (message: unknown) => void;
  windowsShellCommand?: string;
} & (
    | { ownedWorker: true; env: NodeJS.ProcessEnv; cleanupBinding: NodeWorkerCleanupBinding }
    | { ownedWorker?: never; env?: NodeJS.ProcessEnv; cleanupBinding?: never }
  );

function reserveStdioEntry(stdio: SpawnStdioEntry[], value: SpawnStdioEntry): number {
  let fd = 3;
  while (stdio[fd] !== undefined && stdio[fd] !== "ignore") {
    fd += 1;
  }
  while (stdio.length <= fd) {
    stdio.push("ignore");
  }
  stdio[fd] = value;
  return fd;
}

/** Prepare transport facts; the host revalidates authority immediately before spawning. */
export function prepareServiceChildRelay(params: ServiceChildRelayParams) {
  const useWindowsJobAnchor =
    process.platform === "win32" && params.windowsShellCommand !== undefined;
  if (params.ownedWorker && !supportsNodeWorkerProcessOwner()) {
    throw new Error("Owned worker relay requires Linux or macOS");
  }
  if (useWindowsJobAnchor && params.stdoutConsumption === "awaited") {
    throw new Error("Windows Job output does not support awaited stdout consumption");
  }
  const stdio: SpawnStdioEntry[] = useWindowsJobAnchor
    ? ["ignore", "ignore", "ignore"]
    : [params.stdinMode === "inherit" ? "inherit" : "pipe", "pipe", "pipe"];
  const secretDelivery = prepareSecretInputStdio(
    stdio,
    useWindowsJobAnchor ? undefined : params.secretInput,
  );
  let deliveryTransferred = false;
  const deliveryOwner = {
    transferSecretInput() {
      deliveryTransferred = true;
      return secretDelivery;
    },
    [Symbol.dispose]() {
      if (!deliveryTransferred) {
        secretDelivery?.[Symbol.dispose]();
      }
    },
  };
  try {
    const controlFd = useWindowsJobAnchor ? undefined : reserveStdioEntry(stdio, "pipe");
    const lineageFd = useWindowsJobAnchor ? undefined : reserveStdioEntry(stdio, "pipe");
    const parentLineageFds = useWindowsJobAnchor
      ? []
      : getInheritedProcessLineageFds().map((fd) => reserveStdioEntry(stdio, fd));
    reserveStdioEntry(stdio, "ipc");
    return {
      useWindowsJobAnchor,
      controlFd,
      lineageFd,
      ownership: params.ownedWorker
        ? {
            ownedWorker: true as const,
            cleanupBinding: params.cleanupBinding,
            parentLineageFds: [lineageFd!, ...parentLineageFds],
          }
        : { lineageFd, parentLineageFds },
      spawn: {
        workerUrl: resolveRuntimeProcessEntrypointUrl(
          useWindowsJobAnchor ? "serviceChildWindowsJobAnchor" : "serviceChildRelay",
        ),
        env: params.ownedWorker ? params.env : process.env,
        detached: useWindowsJobAnchor || params.ownedWorker === true || parentLineageFds.length > 0,
        stdio,
      },
      ...deliveryOwner,
    };
  } catch (error) {
    deliveryOwner[Symbol.dispose]();
    throw error;
  }
}
