import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
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
  type: "lineage-loading" | "lineage-loaded" | "spawn" | "command-exit" | "duplicate-start";
  pid?: number;
};

type ControlPayload<Message = ServiceChildControlMessage> =
  Message extends ServiceChildControlMessage ? Omit<Message, "generation" | "sequence"> : never;

export function readLines(stream: Duplex, receive: (line: string) => void) {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk: Buffer) => {
    pending += decoder.write(chunk);
    for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      receive(line);
    }
  });
}

function observeMessages<Message extends { type: string }>(
  stream: Duplex,
  receive?: (message: Message) => void,
) {
  const messages: Message[] = [];
  const events = new EventEmitter();
  const waitFor = (...types: string[]) => {
    const received = messages.find((message) => types.includes(message.type));
    return received
      ? Promise.resolve(received)
      : new Promise<Message>((resolve) => {
          for (const type of types) {
            events.once(type, resolve);
          }
        });
  };
  readLines(stream, (line) => {
    const message = JSON.parse(line) as Message;
    messages.push(message);
    receive?.(message);
    events.emit(message.type, message);
  });
  return { messages, waitFor };
}

export function createHeldAnchorPreparation(
  root: string,
  options: { acknowledgeStartupError?: boolean } = {},
) {
  const generation = "held-lineage-preparation";
  const commandSource = `
    process.on("message", () => process.disconnect());
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
        filter: /[/\\\\]service-child-group-anchor(?:-[A-Za-z0-9_-]+)?\\.[cm]?[jt]s$/,
        transform(_url, readSource) {
          const original = readSource();
          const gate = 'globalThis[Symbol.for("openclaw.anchor-preparation-test")]';
          // Hold the awaited preparation in both source and standalone output,
          // where the bundler inlines the lineage module's initialization.
          const preparation = /(lineageCompletion\\s*=\\s*)([\\s\\S]*?);/;
          if (!preparation.test(original)) throw new Error("Missing anchor lineage preparation");
          return original.replace(preparation, (_match, assignment, expression) =>
            assignment + "await (async () => { " + gate + '.emit({type:"lineage-loading"}); await '
              + gate + ".released; const loaded = " + expression + "; "
              + gate + '.emit({type:"lineage-loaded"}); return loaded; })();');
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
  const pipesClosed = child.stdio
    .filter((stream) => stream != null)
    .map(
      (stream) =>
        new Promise<void>((resolve) => {
          stream.once("close", () => resolve());
        }),
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
  const { messages: facts, waitFor } = observeMessages<PreparationFact>(probe);
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
  const { messages, waitFor: waitForControl } = observeMessages<ServiceChildAnchorMessage>(
    control,
    (message) => {
      if (message.type === "startup-error" && options.acknowledgeStartupError !== false) {
        send({ type: "startup-error-ack" });
      } else if (message.type === "closing") {
        send({ type: "closing-ack", closingSequence: message.sequence });
      }
    },
  );
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
    firstFact: () => beforeClose(waitFor("lineage-loading", "spawn")),
    spawned: () => beforeClose(waitFor("spawn")),
    loading: () => beforeClose(waitFor("lineage-loading")),
    prepared: () => beforeClose(waitFor("lineage-loaded")),
    startupError: () => beforeClose(waitForControl("startup-error")),
    duplicateStart: () => {
      child.send({ ...start, generation: `${generation}-replacement` });
      return beforeClose(waitFor("duplicate-start"));
    },
    parentLoss: () => child.send({ type: "parent-loss", generation }),
    ready: () => beforeClose(waitForControl("ready")),
    rootResult: () => beforeClose(waitForControl("root-result")),
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
