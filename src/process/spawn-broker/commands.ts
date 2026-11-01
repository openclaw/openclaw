import type { SpawnOptions } from "node:child_process";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createDeferredCore } from "../../shared/deferred.js";
import type { SpawnInitiation } from "../spawn-initiation.js";
import { BrokerChild } from "./child.js";
import type { BrokerExecaOptions, BrokerExecaResult } from "./execa-protocol.js";
import { brokerSpawnOptions } from "./pipe.js";
import type { BrokerRequest, BrokerSpawnOptions, ProcessOutputFile } from "./protocol.js";

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
