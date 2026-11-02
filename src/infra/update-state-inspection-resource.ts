import fs from "node:fs";
import { settleCommandProcessGroups } from "../process/command-process-custody.js";
import type { CommandProcessIdentity } from "../process/command-process-custody.types.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import {
  runUtf8CommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../process/exec.js";
import { retireSqliteSnapshotPayload } from "./sqlite-readonly-location-cleanup.js";
import { beginSqliteSnapshotRetirement } from "./sqlite-snapshot-retirement.js";
import { createSqliteSnapshotStagingTokenSync } from "./sqlite-snapshot-staging.js";
import { encodeNativeWorkerFailure, type NativeWorkerFailure } from "./worker-native-error.js";
import type { NativeWorkerResourceModule } from "./worker-native-lifecycle.types.js";

export type StateInspectionOptions = Omit<
  CommandOptions,
  "beforeInput" | "stdinFileDescriptor" | "preserveOutputLine"
>;
export type StateInspectionRequest =
  | {
      type: "run";
      id: number;
      argv: string[];
      options: Omit<StateInspectionOptions, "signal" | "onOutputChunk">;
    }
  | { type: "cancel"; id: number };
export type StateInspectionFailure = { error: NativeWorkerFailure; uncertain: boolean };
export type StateInspectionReply =
  | { type: "allocated"; directory: string }
  | { type: "output"; id: number; chunk: Uint8Array; stream: "stdout" | "stderr" }
  | { type: "result"; id: number; value: SpawnResult }
  | ({ type: "error"; id: number } & StateInspectionFailure);

/** This surviving owner creates the commands and retires their bytes only after native settlement. */
export const createNativeWorkerResource: NativeWorkerResourceModule["createNativeWorkerResource"] =
  (port, input) => {
    // SAFETY: The paired inspection launcher supplies this private resource input.
    const { root, allowLegacyWorker } = input as { root: string; allowLegacyWorker: boolean };
    const owned = createSqliteSnapshotStagingTokenSync(root, allowLegacyWorker);
    const commands = new Map<number, { controller: AbortController; work: Promise<void> }>();
    const identities = new Map<symbol, CommandProcessIdentity>();
    let closing = false;
    let connected = true;
    port.on("close", () => {
      connected = false;
    });
    const send = (reply: StateInspectionReply) => {
      if (connected) {
        port.postMessage(reply);
      }
    };
    const cleanup = (): unknown[] => {
      const errors: unknown[] = [];
      try {
        const retirement = beginSqliteSnapshotRetirement(owned.directory, { token: owned.release });
        try {
          for (const _ of retireSqliteSnapshotPayload(retirement)) {
            /* Native work has joined. */
          }
          fs.rmSync(owned.directory, { recursive: true, force: true });
        } finally {
          retirement.release();
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        owned.release();
      } catch (error) {
        throw new AggregateError(
          [...errors, error],
          `State inspection native custody did not close: ${owned.directory}`,
          { cause: error },
        );
      }
      return errors;
    };
    port.on("message", (value) => {
      // SAFETY: The paired launcher is the sole sender on this private resource socket.
      const request = value as StateInspectionRequest;
      if (request.type === "cancel") {
        commands.get(request.id)?.controller.abort();
        return;
      }
      if (closing) {
        throw new Error("State inspection command admission is closed");
      }
      const controller = new AbortController();
      const work = withCommandProcessScope(
        () =>
          runUtf8CommandWithTimeout(request.argv, {
            ...request.options,
            signal: controller.signal,
            onOutputChunk: (chunk, stream) =>
              send({ type: "output", id: request.id, chunk, stream }),
          }),
        controller.signal,
        {
          reserve() {
            const key = Symbol("state-inspection-command");
            return {
              spawned: (identity) => {
                identities.set(key, identity);
              },
              settled: () => {
                identities.delete(key);
              },
            };
          },
        },
      )
        .then(
          (result) => send({ type: "result", id: request.id, value: result }),
          (error: unknown) =>
            send({
              type: "error",
              id: request.id,
              error: encodeNativeWorkerFailure(error),
              uncertain: hasCommandProcessCleanupError(error),
            }),
        )
        .finally(() => {
          commands.delete(request.id);
        });
      commands.set(request.id, { controller, work });
    });
    try {
      send({ type: "allocated", directory: owned.directory });
    } catch (error) {
      throw new AggregateError(
        [error, ...cleanup()],
        `State inspection allocation failed: ${owned.directory}`,
        { cause: error },
      );
    }
    return {
      encodeCloseError: (error): StateInspectionFailure => ({
        error: encodeNativeWorkerFailure(error),
        uncertain: hasCommandProcessCleanupError(error),
      }),
      async close() {
        closing = true;
        for (const command of commands.values()) {
          command.controller.abort();
        }
        await Promise.allSettled([...commands.values()].map((command) => command.work));
        // A rejected scope is not exit proof. Native admission receipts retain any unresolved group.
        if (identities.size) {
          const settlement = await settleCommandProcessGroups([...identities.values()]);
          if (!settlement.settled) {
            throw new CommandProcessCleanupError({ cause: new Error(settlement.reason) });
          }
          identities.clear();
        }
        const errors = cleanup();
        return errors.length
          ? {
              cleanupError: new AggregateError(
                errors,
                `State inspection staging cleanup failed: ${owned.directory}`,
              ),
            }
          : undefined;
      },
    };
  };
