import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { requireNodeWorkerProcessIdentity } from "../../node-host/node-worker-process-identity.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildControlMessage,
  ServiceChildStart,
} from "./service-child-protocol.js";

type PreparationFact = {
  type:
    | "lineage-loading"
    | "lineage-loaded"
    | "spawn"
    | "command-exit"
    | "loader-entry"
    | "loader-match"
    | "loader-error"
    | "duplicate-start";
  url?: string;
  format?: string;
  error?: string;
  pid?: number;
};

type ControlPayload<Message = ServiceChildControlMessage> =
  Message extends ServiceChildControlMessage ? Omit<Message, "generation" | "sequence"> : never;

export function createHeldAnchorPreparation(
  root: string,
  options: { acknowledgeStartupError?: boolean } = {},
) {
  const generation = "held-lineage-preparation";
  const commandSource = `
    process.on("message", message => {
      if (message.type === "openclaw-worker-start-v1") {
        process.send({ type: "synthetic-worker-started" });
        process.disconnect();
      }
    });
    process.once("disconnect", () => process.exit(0));
  `;
  const preload = path.join(root, "held-lineage-loader.mjs");
  fs.writeFileSync(
    preload,
    `
      import childProcess from "node:child_process";
      import { registerFixtureSourceTransform, syncFixtureBuiltinExports } from ${JSON.stringify(
        new URL("../../../test/scripts/fixtures/ci-fixture-runtime.cjs", import.meta.url).href,
      )};
      import { Socket } from "node:net";
      const probe = process.versions.bun
        ? new Socket({ readable: true, writable: true })
        : new Socket({ fd: 6, readable: true, writable: true });
      probe.on("error", () => {});
      const emit = fact => probe.write(JSON.stringify(fact) + "\\n");
      let release;
      const released = new Promise(resolve => { release = resolve; });
      probe.on("data", () => release());
      if (process.versions.bun) probe.connect({ fd: 6 });
      emit({ type: "loader-entry", url: process.argv[1] });
      globalThis[Symbol.for("openclaw.anchor-preparation-test")] = {
        emit,
        released,
      };
      const nativeSpawn = childProcess.spawn;
      childProcess.spawn = function(...args) {
        const child = nativeSpawn.apply(this, args);
        if (args[0] === process.execPath && args[1]?.[1] === ${JSON.stringify(commandSource)}) {
          if (child.pid) emit({ type: "spawn", pid: child.pid });
          child.once("exit", () => emit({ type: "command-exit", pid: child.pid }));
        }
        return child;
      };
      syncFixtureBuiltinExports(["node:child_process"]);
      process.on("message", message => {
        if (message.type === "start" && message.generation === "held-lineage-preparation-replacement") {
          emit({ type: "duplicate-start" });
        }
      });
      registerFixtureSourceTransform({
        name: "held-lineage-preparation",
        filter: /[/\\\\]node-worker-lineage-completion(?:-[A-Za-z0-9_-]+)?\\.[cm]?[jt]s$/,
        transform(url, readSource) {
          let original;
          try { original = readSource(); } catch (error) {
            emit({ type: "loader-error", url, error: error.message });
            throw error;
          }
          emit({ type: "loader-match", url });
          const gate = 'globalThis[Symbol.for("openclaw.anchor-preparation-test")]';
          return gate + '.emit({type:"lineage-loading"});\\nawait ' + gate + '.released;\\n'
            + original + '\\n' + gate + '.emit({type:"lineage-loaded"});\\n';
        },
      });
    `,
  );
  const anchorArgv = resolveRuntimeWorkerArgv(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.serviceChildGroupAnchor),
  );
  const child = spawn(
    process.execPath,
    [...anchorArgv.slice(0, -1), "--import", pathToFileURL(preload).href, anchorArgv.at(-1)!],
    { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "ipc", "pipe"] },
  );
  const exited = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const disconnected = createDeferred();
  child.once("exit", (code, signal) => exited.resolve({ code, signal }));
  child.once("error", exited.reject);
  child.once("disconnect", () => disconnected.resolve());
  const pipesClosed = child.stdio.flatMap((stream) =>
    stream
      ? [
          new Promise<void>((resolve) => {
            stream.once("close", () => resolve());
          }),
        ]
      : [],
  );
  // Native Node can omit aggregate close after explicit IPC disconnect with extra pipes.
  const closed = Promise.all([exited.promise, disconnected.promise, Promise.all(pipesClosed)]).then(
    ([result]) => result,
  );
  const control = child.stdio[3];
  const lineage = child.stdio[4];
  const probe = child.stdio.at(6);
  if (!(control instanceof Duplex) || !(lineage instanceof Duplex) || !(probe instanceof Duplex)) {
    child.kill("SIGKILL");
    throw new Error("Missing anchor fixture descriptors");
  }
  const facts: PreparationFact[] = [];
  const messages: ServiceChildAnchorMessage[] = [];
  const firstFact = createDeferred<PreparationFact>();
  const spawned = createDeferred<PreparationFact>();
  const loading = createDeferred<PreparationFact>();
  const prepared = createDeferred<PreparationFact>();
  const duplicate = createDeferred<PreparationFact>();
  const startupError = createDeferred<ServiceChildAnchorMessage>();
  const ready = createDeferred<ServiceChildAnchorMessage>();
  const rootResult = createDeferred<ServiceChildAnchorMessage>();
  let sequence = 0;
  let stderr = "";
  const send = (message: ControlPayload) => {
    if (!control.destroyed && !control.writableEnded) {
      control.write(`${JSON.stringify({ ...message, generation, sequence: ++sequence })}\n`);
    }
  };
  control.on("error", () => {});
  probe.on("error", () => {});
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  let controlPending = "";
  control.setEncoding("utf8").on("data", (chunk: string) => {
    controlPending += chunk;
    for (;;) {
      const newline = controlPending.indexOf("\n");
      if (newline < 0) {
        return;
      }
      // The owned anchor is the sole writer on this fixture's private control pipe.
      const message = JSON.parse(controlPending.slice(0, newline)) as ServiceChildAnchorMessage;
      controlPending = controlPending.slice(newline + 1);
      messages.push(message);
      if (message.type === "ready") {
        ready.resolve(message);
      } else if (message.type === "root-result") {
        rootResult.resolve(message);
      } else if (message.type === "startup-error") {
        startupError.resolve(message);
        if (options.acknowledgeStartupError !== false) {
          send({ type: "startup-error-ack" });
        }
      } else if (message.type === "closing") {
        send({ type: "closing-ack", closingSequence: message.sequence });
      }
    }
  });
  let probePending = "";
  probe.setEncoding("utf8").on("data", (chunk: string) => {
    probePending += chunk;
    for (;;) {
      const newline = probePending.indexOf("\n");
      if (newline < 0) {
        return;
      }
      // The fixture preload observes real module evaluation and native child events.
      const fact = JSON.parse(probePending.slice(0, newline)) as PreparationFact;
      probePending = probePending.slice(newline + 1);
      facts.push(fact);
      if (fact.type === "lineage-loading" || fact.type === "spawn") {
        firstFact.resolve(fact);
      }
      if (fact.type === "spawn") {
        spawned.resolve(fact);
      } else if (fact.type === "lineage-loading") {
        loading.resolve(fact);
      } else if (fact.type === "lineage-loaded") {
        prepared.resolve(fact);
      } else if (fact.type === "duplicate-start") {
        duplicate.resolve(fact);
      }
    }
  });
  lineage.once("end", () => send({ type: "lineage-closed" }));
  lineage.resume();
  const start: ServiceChildStart = {
    type: "start",
    generation,
    command: process.execPath,
    args: ["-e", commandSource],
    env: {},
    stdinMode: "pipe-closed",
    controlFd: 3,
    lineageFd: 4,
    acknowledgeClosing: true,
    ownedWorker: true,
    cleanupBinding: {
      databasePath: path.join(root, "unrecorded-launch.sqlite"),
      externallySupervised: false,
      launchId: "preparation-worker",
      planHash: "a".repeat(64),
      supervisor: requireNodeWorkerProcessIdentity(process.pid),
    },
  };
  const beforeClose = <T>(operation: Promise<T>) =>
    Promise.race([
      operation,
      closed.then((result) => {
        throw new Error(`Anchor closed before fixture event: ${JSON.stringify(result)} ${stderr}`);
      }),
    ]);
  child.send(start);
  return {
    child,
    control,
    facts,
    messages,
    generation,
    databasePath: start.cleanupBinding.databasePath,
    descriptorsClosed: () => control.destroyed && lineage.destroyed && probe.destroyed,
    firstFact: () => beforeClose(firstFact.promise),
    spawned: () => beforeClose(spawned.promise),
    loading: () => beforeClose(loading.promise),
    prepared: () => beforeClose(prepared.promise),
    startupError: () => beforeClose(startupError.promise),
    duplicateStart: () => {
      child.send({ ...start, generation: `${generation}-replacement` });
      return beforeClose(duplicate.promise);
    },
    parentLoss: () => child.send({ type: "parent-loss", generation }),
    ready: () => beforeClose(ready.promise),
    rootResult: () => beforeClose(rootResult.promise),
    closed,
    send,
    release: () => {
      if (!probe.destroyed && !probe.writableEnded) {
        probe.write("release\n");
      }
    },
    async dispose() {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid!, "SIGKILL");
      }
      await closed;
      control.destroy();
      lineage.destroy();
      probe.destroy();
      for (const fact of facts) {
        if (fact.type === "spawn" && fact.pid && !isPidDefinitelyDead(fact.pid)) {
          throw new Error(`Commanded fixture process ${fact.pid} survived group cleanup`);
        }
      }
    },
  };
}
