import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MessageChannel, Worker, type Transferable } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { BrokerResourceAttachment } from "../process/spawn-broker/resource-protocol.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "./runtime-worker-url.js";
import { nativeWorkerLifecycleEntrypoint } from "./worker-native-lifecycle.runtime.test-support.js";
import type { NativeWorkerReply, NativeWorkerRequest } from "./worker-native-lifecycle.types.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const exec = promisify(execFile);
const workerUrl = resolveRuntimeWorkerUrl(nativeWorkerLifecycleEntrypoint);
const fixtureArgv = resolveRuntimeWorkerArgv(workerUrl);

type Ending = (typeof cases)[number]["ending"] | "resource-late-attachment";

async function runFixture(ending: Ending): Promise<unknown> {
  const home = directories.make("worker-native-lifecycle-");
  const { stdout } = await exec(process.execPath, [...fixtureArgv, ending, home], {
    timeout: ending === "resource-late-attachment" ? 45_000 : 15_000,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home, TSX_DISABLE_CACHE: "1" },
  });
  return JSON.parse(stdout);
}

const trueFields = (keys: string) => Object.fromEntries(keys.split(" ").map((key) => [key, true]));
const resourceCustody = trueFields(
  "firstCloseRejected sameOwnerRetried childClosedBeforeStopped sqliteReusable",
);
const callbackContext = ["message", "error", "exit"].map((event) => ({
  event,
  context: "constructor-A",
}));
const nativeExit = {
  value: 42,
  ...trueFields("nativeJoined nestedSqliteReleased"),
  promiseCallbackRanWhileBlocked: false,
};
const cases = [
  { ending: "reference-liveness", activeCompleted: true },
  {
    ending: "resource-idle-broker",
    ...resourceCustody,
    ...trueFields("independentCustodyPreserved idleBrokerJoined sourceReusable"),
  },
  {
    ending: "callback-context",
    directSeen: callbackContext,
    retainedSeen: callbackContext,
    ...trueFields("diagnosticsPreserved joined"),
  },
  { ending: "native-resource", ...resourceCustody },
  {
    ending: "explicit-unbound",
    value: 42,
    ...trueFields("ambientReleased nativeJoined idleReused shutdownJoined"),
  },
  { ending: "terminate", ...nativeExit },
  { ending: "natural-exit", ...nativeExit },
  {
    ending: "generation",
    order: [
      "operation",
      "owner-close-start",
      "queued-worker-started",
      "worker-usable-during-close",
      "native-joined",
      "sibling-owner-close",
      "sibling-native-joined",
      "release",
    ],
    ...trueFields(
      "nativeJoined siblingJoined supervisorJoined directoryReleased terminalSamplesRejected",
    ),
  },
] as const;

it.each(cases)(
  "retained native worker lifecycle preserves custody during $ending",
  async ({ ending, ...expected }) => {
    expect(await runFixture(ending)).toEqual({ ending, ...expected });
  },
  20_000,
);

it("attaches a second resource to the same healthy broker after its cold startup deadline", async () => {
  expect(await runFixture("resource-late-attachment")).toEqual({
    ending: "resource-late-attachment",
    lateSameBrokerAttached: true,
    ...resourceCustody,
  });
}, 50_000);

const supervisorUrl = new URL("./worker-native-lifecycle.worker.ts", import.meta.url);
const echoChild = `data:text/javascript,${encodeURIComponent(
  'import { parentPort } from "node:worker_threads";' +
    'parentPort.on("message", (value) => { if (typeof value === "string") parentPort.postMessage(value); });',
)}`;
const supervisors: Worker[] = [];

afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.terminate()));
});

function startSupervisor() {
  const { port1, port2 } = new MessageChannel();
  const supervisor = new Worker(supervisorUrl, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(supervisorUrl),
    workerData: { port: port2 },
    transferList: [port2],
  });
  supervisors.push(supervisor);
  const replies: NativeWorkerReply[] = [];
  const waiters = new Set<() => void>();
  let exitCode: number | undefined;
  let failure: Error | undefined;
  const notify = () => waiters.forEach((wake) => wake());
  port1.on("message", (reply: NativeWorkerReply) => {
    replies.push(reply);
    notify();
  });
  supervisor.once("error", (error) => {
    failure = toErrorObject(error, "Native worker supervisor failed");
    notify();
  });
  supervisor.once("exit", (code) => {
    exitCode = code;
    port1.close();
    notify();
  });
  return {
    replies,
    exitCode: () => exitCode,
    post: (request: NativeWorkerRequest, transfers: Transferable[] = []) =>
      port1.postMessage(request, transfers),
    until(done: () => boolean) {
      return new Promise<void>((resolve, reject) => {
        const check = () => {
          if (failure) {
            waiters.delete(check);
            reject(failure);
          } else if (done() || exitCode !== undefined) {
            waiters.delete(check);
            resolve();
          }
        };
        waiters.add(check);
        check();
      });
    },
  };
}

function createRequest(
  id: number,
  extra: Pick<NativeWorkerRequest & { type: "create" }, "resource" | "taskPort"> = {},
): NativeWorkerRequest {
  return {
    type: "create",
    id,
    filename: { kind: "url", value: echoChild },
    environmentData: [],
    options: { environment: {}, shareEnvironment: true },
    transferList: [],
    ...extra,
  };
}

it("keeps the supervisor alive when a resource attachment endpoint is rejected synchronously", async () => {
  const supervisor = startSupervisor();
  const types = (id: number) =>
    supervisor.replies.filter((reply) => reply.id === id).map((reply) => reply.type);
  const task = new MessageChannel();
  // Deliberately malformed: production endpoints are strings, but net.connect throws
  // ERR_SOCKET_BAD_PORT synchronously for an out-of-range numeric port.
  const attachment = {
    endpoint: 70_000,
    secret: "synthetic",
    generation: 1,
    id: 1,
    moduleUrl: "data:text/javascript,",
    ownerPort: false,
  } as unknown as BrokerResourceAttachment;
  supervisor.post(
    createRequest(1, { resource: { workerDataKey: "resource", attachment }, taskPort: task.port2 }),
    [task.port2],
  );
  await supervisor.until(() => types(1).includes("stop-error"));
  task.port1.close();

  expect(supervisor.exitCode()).toBeUndefined();
  expect(types(1)).toEqual(["created", "error", "execution-exit", "stop-error"]);
  const failure = supervisor.replies.find((reply) => reply.id === 1 && reply.type === "error");
  expect(failure).toMatchObject({
    error: { name: "RangeError", message: expect.stringContaining("70000") },
  });

  supervisor.post(createRequest(2));
  await supervisor.until(() => types(2).includes("created"));
  supervisor.post({ type: "post", id: 2, value: "ping", transferList: [] });
  await supervisor.until(() => types(2).includes("message"));
  supervisor.post({ type: "stop", id: 2 });
  await supervisor.until(() => types(2).includes("stopped"));

  expect(supervisor.exitCode()).toBeUndefined();
  expect(supervisor.replies).toContainEqual({ type: "message", id: 2, value: "ping" });
}, 30_000);
