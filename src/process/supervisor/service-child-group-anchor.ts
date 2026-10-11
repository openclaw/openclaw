import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { closeSync } from "node:fs";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../../shared/deferred.js";
import { spawnWithInheritedOomScore } from "../linux-oom-score.js";
import type { SpawnStdioEntry } from "../spawn-secret-input.js";
import { GRACEFUL_CANCEL_TIMEOUT_MS } from "./cancellation-policy.js";
import {
  hasLiveOwnedProcessGroupMembers,
  killOwnedProcessGroupMembers,
} from "./service-child-group-ownership.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildAnchorPayload,
  type ServiceChildControlMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";
import { reserveStdioEntry, setStdioEntry } from "./service-child-stdio.js";

type AnchorState = "starting" | "active" | "closing" | "closed";
declare const WORKER_DEPLOY_BUILD: boolean;

function commandStdio(start: ServiceChildStart) {
  const stdio: SpawnStdioEntry[] = [
    start.stdinMode === "inherit" ? "inherit" : "pipe",
    "pipe",
    "pipe",
  ];
  if (start.secretFd !== undefined) {
    setStdioEntry(stdio, start.secretFd, start.secretFd);
  }
  const lineageFd = reserveStdioEntry(stdio, start.lineageFd ?? "pipe");
  const inheritedLineageFds = [
    lineageFd,
    ...(start.parentLineageFds ?? []).map((fd) => reserveStdioEntry(stdio, fd)),
  ];
  if (start.ownedWorker) {
    stdio.push("ipc");
  }
  return { stdio, lineageFd, inheritedLineageFds };
}

function delay(ms: number, retainOwner = false): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!retainOwner) {
      timer.unref?.();
    }
  });
}

export function runServiceChildGroupAnchor(): void {
  const launchGrant = createDeferredCore();
  let start: ServiceChildStart | undefined;
  let subreaper:
    | ReturnType<typeof import("./linux-child-subreaper.js").acquireLinuxChildSubreaper>
    | undefined;
  let descendantsReaped = false;
  let state: AnchorState = "starting";
  let sequence = 0;
  let lastHostSequence = 0;
  let command: ChildProcess | undefined;
  let lineageCompletion:
    | typeof import("../../node-host/node-worker-lineage-completion.js")
    | undefined;
  let inheritedLineageClosed = false;
  let workerStarted = false;
  let workerLineageFds: number[] = [];
  let control: Socket | undefined;
  let rootSettlementStarted = false;
  let rootResultDelivery: Promise<void> | undefined;
  let rootExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const pendingOutput = new Set(["stdout", "stderr"] as const);
  let lineageClosed = false;
  let lineageObservationFailed = false;
  let markHostLineageClosed: (() => void) | undefined;
  let forceCleanup = false;
  const forceCleanupRequested = createDeferredCore();
  const lineageDone = createDeferredCore();
  const rootExited = createDeferredCore();
  const rootSettledDone = createDeferredCore();
  const startupErrorAcknowledged = createDeferredCore();
  const retirementReady = createDeferredCore<boolean>();
  let closingSequence: number | undefined;

  const send = async (message: ServiceChildAnchorPayload) => {
    if (!start || !control || control.destroyed) {
      return;
    }
    sequence += 1;
    await new Promise<void>((resolve) => {
      control!.write(
        encodeServiceChildMessage({ ...message, generation: start!.generation, sequence }),
        () => resolve(),
      );
    });
  };

  const finish = (code: number) => {
    process.exitCode = code;
    process.stdin.destroy();
    const disconnect = () => {
      // end() flushes the receipt; destroy() also releases the readable socket.
      control?.off("close", disconnect);
      control?.destroy();
      if (process.connected) {
        process.disconnect?.();
      }
    };
    if (control && !control.destroyed) {
      control.once("close", disconnect);
      control.end(disconnect);
    } else {
      disconnect();
    }
  };

  const closeAuthority = async (
    reason: Extract<ServiceChildAnchorMessage, { type: "closing" }>["reason"],
    hardKill: boolean,
    deadline = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS,
  ) => {
    if (!start || state === "closed") {
      return;
    }
    if (start.treeOwnership === "linux-subreaper") {
      // Never exchange owner death for descendant extinction. Startup failure
      // before admission has no application root; every admitted scope must drain.
      if (command && !descendantsReaped) {
        throw new Error("native owner cannot close before descendant extinction");
      }
      state = "closed";
      for (const fd of new Set(start.parentLineageFds ?? [])) {
        closeSync(fd);
      }
      closingSequence = sequence + 1;
      await send({
        type: "closing",
        reason,
        ...(descendantsReaped ? { descendantsReaped: true } : {}),
      });
      const acknowledged = await Promise.race([
        retirementReady.promise,
        delay(Math.max(0, deadline - Date.now())).then(() => false),
      ]);
      finish(acknowledged ? 0 : 1);
      return;
    }
    state = "closed";
    // Retained hosts have no observer outside this group. Killing the local
    // reader with unresolved lineage must not certify escaped descendants gone.
    if (hardKill && start.lineageFd === undefined && !lineageClosed) {
      process.kill(0, "SIGKILL");
      return;
    }
    // Kernel acceptance is not host consumption. Keep the read side alive so a
    // crossing cancellation cannot destroy the host's unread closing receipt.
    const requiresAcknowledgement = start.acknowledgeClosing === true;
    closingSequence = requiresAcknowledgement ? sequence + 1 : undefined;
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      void send({ type: "closing", reason }).then(
        () => {
          // --no-restart can retain an old host across replacement of these workers.
          // Preserve its prior protocol until restart; new hosts always request ACKs.
          if (!requiresAcknowledgement) {
            retirementReady.resolve(true);
          }
        },
        () => retirementReady.resolve(false),
      );
    }
    if (
      remainingMs <= 0 ||
      !(await Promise.race([retirementReady.promise, delay(remainingMs).then(() => false)])) ||
      Date.now() >= deadline ||
      hardKill
    ) {
      process.kill(0, "SIGKILL");
      return;
    }
    finish(0);
  };

  const closeInheritedLineage = () => {
    if (start?.lineageFd !== undefined && !inheritedLineageClosed) {
      inheritedLineageClosed = true;
      closeSync(start.lineageFd);
    }
  };

  const reportStartupFailure = async (error: string, hardKill = false) => {
    closeInheritedLineage();
    await send({ type: "startup-error", error });
    // A write callback only proves kernel acceptance. Keep the exact anchor alive until the
    // host records the authoritative spawn failure and acknowledges it on this same channel.
    await Promise.race([startupErrorAcknowledged.promise, retirementReady.promise]);
    if (subreaper) {
      while (!(descendantsReaped = subreaper.drain("SIGKILL"))) {
        await delay(10, true);
      }
    }
    await closeAuthority("lineage-lost", hardKill);
  };

  const requestCleanup = async (
    reason: "cancel" | "lineage-lost" | "parent-lost",
    signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
  ) => {
    if (!start || state === "closed") {
      return;
    }
    if (state === "closing") {
      forceCleanup ||= signal === "SIGKILL";
      if (forceCleanup) {
        forceCleanupRequested.resolve();
      }
      return;
    }
    state = "closing";
    forceCleanup = signal === "SIGKILL";
    if (!command) {
      await reportStartupFailure("command startup cancelled before spawn", true);
      return;
    }
    const cleanupDeadline = Date.now() + GRACEFUL_CANCEL_TIMEOUT_MS;
    if (subreaper) {
      try {
        while (
          !subreaper.drain(forceCleanup || Date.now() >= cleanupDeadline ? "SIGKILL" : "SIGTERM")
        ) {
          // Yield so libuv can consume its one direct root. Adopted children stay
          // with the native wait owner even after the caller gives up waiting.
          await delay(10, true);
        }
        descendantsReaped = true;
        await rootExited.promise;
        await rootResultDelivery;
        await rootSettledDone.promise;
        await lineageDone.promise;
        if (!lineageClosed) {
          throw new Error("native owner lost lineage observation before EOF");
        }
        if (start.ownedWorker && lineageCompletion) {
          let recorded = false;
          try {
            recorded = lineageCompletion.recordNodeWorkerDescendantsReaped(start.cleanupBinding);
          } catch {
            // The live host can still consume this exact kernel proof. A new
            // supervisor must retain custody without the separate durable fact.
          }
          if (!recorded) {
            await send({
              type: "output",
              stream: "stderr",
              chunk:
                "node worker descendant extinction was not recorded; restart recovery retains capacity\n",
            });
          }
        }
        await closeAuthority(reason, false);
      } catch (error) {
        // Failed native custody remains owned and unknown. Transport closure must
        // not turn a denied signal or failed durable write into a closing receipt.
        await send({
          type: "result-error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    const termGraceDone = delay(GRACEFUL_CANCEL_TIMEOUT_MS);
    if (start.ownedWorker) {
      if (!forceCleanup) {
        process.kill(0, "SIGTERM");
      }
      const settled = Promise.all([rootExited.promise, lineageDone.promise]);
      if (!forceCleanup) {
        await Promise.race([settled, termGraceDone, forceCleanupRequested.promise]);
      }
      if (!rootExit) {
        command?.kill("SIGKILL");
      }
      if (!lineageClosed) {
        killOwnedProcessGroupMembers();
      }
      // Nested command relays can outlive the application. Keep their reader alive
      // until they close lineage; killing this observer would discard that custody.
      await settled;
      await rootResultDelivery;
      let lineageRecorded = false;
      if (rootExit && lineageClosed && lineageCompletion) {
        try {
          lineageRecorded = lineageCompletion.recordNodeWorkerLineageSettled(start.cleanupBinding);
        } catch {
          // An unrecorded completion remains unknown to the next node host.
        }
      }
      if (!lineageRecorded) {
        await send({
          type: "output",
          stream: "stderr",
          chunk:
            "node worker lineage completion was not recorded; restart recovery will retain capacity until cleanup can be verified\n",
        });
      }
      if (!forceCleanup) {
        await Promise.race([rootSettledDone.promise, termGraceDone, forceCleanupRequested.promise]);
      }
      await closeAuthority(reason, true);
      return;
    }
    if (!forceCleanup) {
      // The anchor catches its own signal while every command-group member receives it.
      process.kill(0, "SIGTERM");
      await Promise.race([lineageDone.promise, termGraceDone, forceCleanupRequested.promise]);
    }
    if (state !== "closing" || !start) {
      return;
    }
    if (lineageClosed && !rootExit && !forceCleanup) {
      // Cleanup already owns the group. A normal root exit may race lineage EOF,
      // but the short observation window must not replace the configured TERM grace.
      await Promise.race([rootExited.promise, termGraceDone, forceCleanupRequested.promise]);
    }
    if (state !== "closing" || !start) {
      return;
    }
    if (rootExit && !forceCleanup) {
      // Output can outlive lineage and the root. It may preserve the authentic root
      // result only within the existing TERM grace, and KILL must wake this wait.
      await Promise.race([rootSettledDone.promise, termGraceDone, forceCleanupRequested.promise]);
      if (state !== "closing" || !start) {
        return;
      }
    }
    for (;;) {
      // Process and control events can change these facts during the awaited observation.
      if (forceCleanup || !rootExit || pendingOutput.size > 0 || !lineageClosed) {
        break;
      }
      const remainingMs = cleanupDeadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      // This census only schedules retirement or escalation; it cannot certify closure.
      // The outside-group host must observe kernel group disappearance after we exit.
      if (hasLiveOwnedProcessGroupMembers(remainingMs) === false) {
        await closeAuthority(reason, false, cleanupDeadline);
        return;
      }
      const nextObservationMs = Math.min(100, cleanupDeadline - Date.now());
      if (nextObservationMs <= 0) {
        break;
      }
      await Promise.race([delay(nextObservationMs), forceCleanupRequested.promise]);
    }
    // Forced retirement needs the same bounded receipt join, even after TERM
    // grace expires. Only the outside-group host can certify extinction after KILL.
    await closeAuthority(reason, true);
  };

  const onControlMessage = (message: ServiceChildControlMessage) => {
    if (
      !start ||
      message.generation !== start.generation ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence <= lastHostSequence
    ) {
      return;
    }
    if (message.type === "closing-ack") {
      if (
        state === "closed" &&
        closingSequence !== undefined &&
        message.closingSequence === closingSequence
      ) {
        lastHostSequence = message.sequence;
        retirementReady.resolve(true);
      }
      return;
    }
    if (state === "closed") {
      return;
    }
    lastHostSequence = message.sequence;
    if (message.type === "launch") {
      launchGrant.resolve();
      return;
    }
    if (message.type === "startup-error-ack") {
      startupErrorAcknowledged.resolve();
      return;
    }
    if (message.type === "lineage-closed") {
      markHostLineageClosed?.();
      return;
    }
    if (message.type === "worker-close") {
      if (start.ownedWorker && !command) {
        void requestCleanup("cancel");
      } else if (start.ownedWorker && command?.connected) {
        command.disconnect();
      }
      return;
    }
    if (message.type === "worker-start") {
      if (!start.ownedWorker || workerStarted || state !== "active") {
        return;
      }
      if (!command?.connected) {
        void requestCleanup("parent-lost");
        return;
      }
      workerStarted = true;
      command.send(
        {
          type: "openclaw-worker-start-v1",
          lineageFds: workerLineageFds,
          ...(start.nativeProcessOwner ? { nativeProcessOwner: start.nativeProcessOwner } : {}),
        },
        (error) => {
          if (error) {
            void requestCleanup("parent-lost");
          }
        },
      );
      return;
    }
    void requestCleanup("cancel", message.signal);
  };

  const startCommand = async (next: ServiceChildStart) => {
    const controlFd = next.controlFd;
    if (controlFd === undefined) {
      state = "closed";
      finish(1);
      return;
    }
    start = next;
    const socket = process.versions.bun
      ? new Socket({ readable: true, writable: true })
      : new Socket({ fd: controlFd, readable: true, writable: true });
    control = socket;
    socket.setEncoding("utf8");
    let pending = "";
    socket.on("data", (chunk: string) => {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          break;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          // SAFETY: the private host control channel only writes encoded control messages.
          onControlMessage(JSON.parse(line) as ServiceChildControlMessage);
        } catch {
          void requestCleanup("parent-lost");
        }
      }
    });
    const onControlLoss = () => {
      retirementReady.resolve(false);
      if (state !== "closed") {
        void requestCleanup("parent-lost");
      }
    };
    socket.once("end", onControlLoss);
    socket.once("close", onControlLoss);
    socket.once("error", onControlLoss);
    if (process.versions.bun) {
      // Attach readers before adoption; end() must shut down the transport after the ACK.
      // SAFETY: Bun 1.4+ uses this fd overload for its own inherited stdio.
      (socket as Socket & { connect(options: { fd: number }): Socket }).connect({ fd: controlFd });
    }

    // Prepare before launch: loading this writer during TERM consumes cleanup grace
    // and can race a source loader's compiler receiving the same group signal.
    lineageCompletion =
      next.ownedWorker && (typeof WORKER_DEPLOY_BUILD !== "boolean" || !WORKER_DEPLOY_BUILD)
        ? await import("../../node-host/node-worker-lineage-completion.js").catch(() => undefined)
        : undefined;
    if (next.treeOwnership === "linux-subreaper") {
      try {
        const nativeOwner =
          typeof WORKER_DEPLOY_BUILD === "boolean" && WORKER_DEPLOY_BUILD
            ? undefined
            : await import("./linux-child-subreaper.js");
        if (!nativeOwner) {
          throw new Error("portable workers require their admitted host-native process owner");
        }
        subreaper = nativeOwner.acquireLinuxChildSubreaper();
      } catch (error) {
        await reportStartupFailure(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    if (next.type === "prepare") {
      await send({ type: "prepared" });
      await Promise.race([launchGrant.promise, retirementReady.promise]);
    }
    if (
      start !== next ||
      control !== socket ||
      state !== "starting" ||
      socket.destroyed ||
      socket.readableEnded ||
      socket.writableEnded ||
      !process.connected
    ) {
      await requestCleanup("parent-lost");
      return;
    }
    const { stdio, lineageFd, inheritedLineageFds } = commandStdio(start);
    workerLineageFds = inheritedLineageFds;
    let shutdownOutput: ((fd: number, how: number) => number) | undefined;
    try {
      if (process.versions.bun && (process.platform === "darwin" || process.platform === "linux")) {
        // SAFETY: Bun's built-in FFI binds only the POSIX socket shutdown ABI here.
        const ffi = createRequire(import.meta.url)("bun:ffi") as {
          dlopen(
            path: string,
            symbols: Record<string, { args: string[]; returns: string }>,
          ): {
            symbols: { shutdown: (fd: number, how: number) => number };
          };
        };
        const library = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
        shutdownOutput = ffi.dlopen(library, {
          shutdown: { args: ["i32", "i32"], returns: "i32" },
        }).symbols.shutdown;
      }
      command = spawnWithInheritedOomScore(start.command, start.args, {
        cwd: start.cwd,
        env: start.env,
        argv0: start.argv0,
        stdio,
        detached: false,
        windowsHide: true,
      });
      if (command.pid) {
        subreaper?.retainLibuvChild(command.pid, command);
      }
      // Failed Bun spawns have no stdio. Preserve the spawn error before checking lineage.
      await once(command, "spawn");
    } catch (error) {
      await reportStartupFailure(error instanceof Error ? error.message : String(error));
      return;
    }
    const markLineageClosed = () => {
      if (lineageClosed || lineageObservationFailed) {
        return;
      }
      lineageClosed = true;
      lineageDone.resolve();
      if (state === "active") {
        // Programs can close inherited descriptors while still running. Keep this
        // observer waiting for the direct child's exit before reclaiming descendants.
        void (async () => {
          await rootExited.promise;
          if (state !== "active") {
            return;
          }
          if (rootSettlementStarted) {
            await rootSettledDone.promise;
          }
          if (state !== "active") {
            return;
          }
          // Root settlement can only complete after output EOF. If lineage is gone
          // while output remains owned by a descendant, cleanup must reclaim the group.
          void requestCleanup("lineage-lost");
        })();
      }
    };
    if (start.lineageFd !== undefined) {
      // Install the notification consumer before releasing the duplicate writer;
      // actual EOF is observed by the host even when this group is killed.
      markHostLineageClosed = markLineageClosed;
      closeInheritedLineage();
    } else {
      // Retained --no-restart hosts still delegate observation to the anchor.
      // SAFETY: without a host descriptor, commandStdio reserves this entry as a pipe.
      const lineage = command.stdio[lineageFd] as Readable | null;
      if (!lineage) {
        await send({ type: "startup-error", error: "command lineage pipe was not created" });
        await requestCleanup("lineage-lost", "SIGKILL");
        return;
      }
      lineage.once("end", markLineageClosed);
      const markLineageFailed = () => {
        if (lineageClosed || lineageObservationFailed) {
          return;
        }
        lineageObservationFailed = true;
        lineageDone.resolve();
        void requestCleanup("lineage-lost");
      };
      lineage.once("close", () => {
        if (!lineage.readableEnded) {
          markLineageFailed();
        }
      });
      lineage.once("error", markLineageFailed);
      lineage.resume();
    }
    const settleRoot = async () => {
      if (rootSettlementStarted || !rootResultDelivery || pendingOutput.size > 0) {
        return;
      }
      rootSettlementStarted = true;
      await rootResultDelivery;
      rootSettledDone.resolve();
      if (lineageClosed && state === "active") {
        await requestCleanup("lineage-lost");
      }
    };
    for (const stream of ["stdout", "stderr"] as const) {
      pipeline(command[stream]!, process[stream], () => {
        // Older Bun needs this half-close; newer Bun can report ENOTCONN after its own.
        // Shutdown completion is not lineage loss; the host still requires output EOF.
        shutdownOutput?.(stream === "stdout" ? 1 : 2, 1);
        pendingOutput.delete(stream);
        void settleRoot();
      });
    }
    if (start.stdinMode !== "inherit" && command.stdin) {
      const input = process.stdin;
      const destination = command.stdin;
      const endInput = () => destination.end();
      let inputClosed = false;
      const stopInput = () => {
        input.unpipe(destination);
        input.off("end", endInput);
        input.destroy();
        if (!inputClosed) {
          inputClosed = true;
          void send({ type: "stdin-closed" });
        }
      };
      destination.once("error", stopInput);
      destination.once("close", stopInput);
      // Own EOF explicitly: pipe's default end check initializes global Bun output writers.
      input.pipe(destination, { end: false });
      if (input.readableEnded) {
        endInput();
      } else {
        input.once("end", endInput);
      }
    }
    command.once("error", (error) => {
      if (state === "starting") {
        void reportStartupFailure(error.message);
      }
    });
    if (start.ownedWorker) {
      command.on("message", (message: unknown) => {
        if (state === "active") {
          void send({ type: "worker-message", message });
        }
      });
    }
    if (command.pid && state === "starting") {
      state = "active";
      void send({
        type: "ready",
        commandPid: command.pid,
        anchorPid: process.pid,
        ...(subreaper ? { treeOwnership: "linux-subreaper" as const } : {}),
      });
    }
    command.once("exit", (code, signal) => {
      rootExit = { code, signal };
      // The host gates public settlement on output EOF, so record the authentic root
      // result before cleanup can hard-close an output-holding descendant.
      rootResultDelivery = send({ type: "root-result", code, signal });
      rootExited.resolve();
      void settleRoot();
      // Worker death retires its scope, but an ordinary command may deliberately
      // leave background descendants. Their lineage still owns natural completion.
      if (subreaper && start?.ownedWorker && state === "active") {
        void requestCleanup("lineage-lost");
      }
    });
  };

  const onParentSignal = () => {
    if (state === "active" || (start && state === "starting")) {
      void requestCleanup("parent-lost");
    }
  };
  process.on("SIGTERM", onParentSignal);
  process.on("SIGINT", onParentSignal);
  process.once("disconnect", () => {
    retirementReady.resolve(false);
    if (state !== "closed") {
      void requestCleanup("parent-lost");
    }
  });
  process.on("message", (raw: unknown) => {
    // SAFETY: the spawned relay is the sole sender on this private IPC channel.
    const message = raw as ServiceChildStart | { type: "parent-loss"; generation?: string };
    if (
      (message.type === "start" || message.type === "prepare") &&
      !start &&
      state === "starting"
    ) {
      if (
        isRecord(raw) &&
        raw.acknowledgeClosing !== undefined &&
        raw.acknowledgeClosing !== true
      ) {
        state = "closed";
        finish(1);
        return;
      }
      void startCommand(message);
    } else if (message.type === "parent-loss" && message.generation === start?.generation) {
      retirementReady.resolve(false);
      void requestCleanup("parent-lost");
    }
  });
}

runServiceChildGroupAnchor();
