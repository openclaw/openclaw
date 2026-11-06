import type { SpawnOptions } from "node:child_process";
import { Socket } from "node:net";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SpawnInitiation } from "../spawn-initiation.js";
import { BrokerChild } from "./child.js";
import type { BrokerExecaOptions, BrokerExecaResult } from "./execa-protocol.js";
import { brokerSpawnOptions, holdPipe, restoreStdinPipe } from "./pipe.js";
import {
  SpawnBrokerError,
  type BrokerRequest,
  type BrokerResponse,
  type BrokerSpawnOptions,
  type ProcessOutputFile,
} from "./protocol.js";

type Command = Extract<BrokerRequest, { type: "spawn" | "prepare-spawn" | "spawn-execa" }>;

export type BrokerCommandRequest = {
  child: BrokerChild;
  initiateSpawn?: SpawnInitiation;
  nativeInitiated?: ReturnType<typeof createDeferredCore<void>>;
  pid?: number;
  detached: boolean;
  result?: ReturnType<typeof createDeferredCore<BrokerExecaResult>>;
  output?: ReturnType<typeof createDeferredCore<number>>;
  childClosed: boolean;
  nativeClosed?: boolean;
  recovering?: boolean;
  resultSettled: boolean;
};

/** Construct receipts; the host alone admits, tracks, and settles the request. */
export function createBrokerCommandRequest(
  message: Command,
  initiateSpawn: SpawnInitiation | undefined,
  transmit: ConstructorParameters<typeof BrokerChild>[2],
): BrokerCommandRequest {
  const output =
    message.type !== "spawn-execa" && message.outputFile ? createDeferredCore<number>() : undefined;
  const result =
    message.type === "spawn-execa" ? createDeferredCore<BrokerExecaResult>() : undefined;
  void output?.promise.catch(() => {});
  void result?.promise.catch(() => {});
  return {
    child: new BrokerChild(message.id, message.argv, transmit, Boolean(output)),
    initiateSpawn,
    result,
    output,
    childClosed: false,
    resultSettled: !result && !output,
    detached:
      message.options.detached === true ||
      (message.type === "spawn-execa" && message.options.killDescendants === true),
  };
}

/** Translate command APIs without owning admission or process lifecycle state. */
export function createBrokerCommands(host: {
  nextId(): number;
  admit(message: Command, initiateSpawn?: SpawnInitiation): BrokerCommandRequest;
  cancel(id: number): Promise<void>;
}) {
  const native = (
    command: string,
    args: string[],
    options: BrokerSpawnOptions,
    initiateSpawn?: SpawnInitiation,
    execCgroup?: string,
    outputFile?: ProcessOutputFile,
  ) => {
    const message: Extract<Command, { type: "spawn" | "prepare-spawn" }> = {
      type: initiateSpawn ? "prepare-spawn" : "spawn",
      id: host.nextId(),
      argv: [command, ...args],
      options,
      execCgroup,
    };
    if (outputFile) {
      message.outputFile = outputFile;
    }
    return host.admit(message, initiateSpawn);
  };
  return {
    spawn: (
      command: string,
      args: string[],
      options: SpawnOptions,
      initiateSpawn?: SpawnInitiation,
      execCgroup?: string,
    ): BrokerChild => {
      const prepared = brokerSpawnOptions(options);
      if (!prepared) {
        throw new Error("Unsupported spawn broker stdio or process options");
      }
      return native(command, args, prepared, initiateSpawn, execCgroup).child;
    },
    spawnToFile: (
      command: string,
      args: string[],
      options: BrokerSpawnOptions,
      outputFile: ProcessOutputFile,
      initiateSpawn?: SpawnInitiation,
      execCgroup?: string,
    ) => {
      const request = native(command, args, options, initiateSpawn, execCgroup, outputFile);
      return { child: request.child, output: request.output!.promise };
    },
    spawnExeca: (argv: string[], options: BrokerExecaOptions, execCgroup?: string) => {
      const id = host.nextId();
      const request = host.admit({ type: "spawn-execa", id, argv, options, execCgroup });
      return {
        child: request.child,
        result: request.result!.promise,
        cancel: () => {
          void host
            .cancel(id)
            .catch((error: unknown) =>
              request.child.fail(toErrorObject(error, "Spawn broker cancellation delivery failed")),
            );
        },
      };
    },
  };
}

/** Translate command receipts; the host retains admission and cleanup decisions. */
export function receiveBrokerCommandResponse(
  request: BrokerCommandRequest,
  message: Exclude<
    BrokerResponse,
    {
      type:
        | "ready"
        | "startup-failed"
        | "prepared"
        | "owned"
        | "file-read-chunk"
        | "file-read-result";
    }
  >,
  handle: unknown,
  transmit: (message: BrokerRequest) => Promise<void>,
): Promise<void> | undefined {
  if (message.type === "pipe") {
    try {
      if (message.closed && message.fd === 0) {
        const stdin = new Socket();
        request.child.attachPipe(message.fd, stdin);
        stdin.destroy();
      } else if (handle instanceof Socket) {
        if (message.fd === 0) {
          restoreStdinPipe(handle);
        } else {
          holdPipe(handle);
        }
        request.child.attachPipe(message.fd, handle);
      } else {
        throw new SpawnBrokerError("Spawn broker pipe transfer failed");
      }
    } catch (error) {
      if (handle instanceof Socket) {
        handle.destroy();
      }
      throw error;
    }
    // The receipt follows Node's internal handle ACK on this same IPC channel.
    return transmit({ type: "pipe-received", id: message.id, fd: message.fd });
  } else if (message.type === "pipe-prefix") {
    const pipe = request.child.stdio[message.fd];
    if (pipe instanceof Socket && message.bytes.length > 0) {
      pipe.unshift(message.bytes);
    }
  } else if (message.type === "file-output") {
    // The worker publishes this only after native completion and writer closure.
    request.nativeClosed = true;
    if ("error" in message) {
      request.output?.reject(Object.assign(new Error(message.error.message), message.error));
    } else {
      request.output?.resolve(message.bytes);
    }
    request.resultSettled = true;
    request.child.settleFileOutput();
  } else if (message.type === "execa-result") {
    // Started commands publish their owned PID first on this ordered channel.
    // A failed result without that admission is the worker's no-process outcome.
    if (request.pid === undefined && message.result.failed) {
      request.child.markNotStarted();
    }
    request.result?.resolve(message.result);
    request.resultSettled = true;
  } else {
    if (message.type === "closed") {
      request.nativeClosed = true;
    } else if (message.type === "error" && message.notStarted) {
      request.child.markNotStarted();
    }
    if (message.type === "error" && message.resultUnavailable && request.output) {
      request.output.reject(Object.assign(new Error(message.error.message), message.error));
      request.resultSettled = true;
      request.child.settleFileOutput();
    }
    if (message.type === "error" && message.resultUnavailable && request.result) {
      request.result.reject(Object.assign(new Error(message.error.message), message.error));
      request.resultSettled = true;
    }
    request.child.receive(message);
  }
  return undefined;
}
