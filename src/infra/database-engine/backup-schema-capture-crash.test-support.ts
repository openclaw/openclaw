import { fork } from "node:child_process";
import { once } from "node:events";
import { Client } from "pg";
import { capturePostgresSchema } from "../../snapshot/database-backup-core.worker.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../runtime-worker-url.js";
import { workboardPortFixture } from "./port-backup.test-support.js";

type CaptureInput = {
  connection: string;
  namespace: string;
  storeId: string;
  directory: string;
  prune: { directoryPrefix: string; captureId: string };
  phase: "before" | "after";
};
type CaptureGate = { namespace: string; backendPid: number };
type CaptureMessage = CaptureGate | { error: string };

/** Kill only the owned child after its real PostgreSQL query reaches the chosen commit boundary. */
export async function crashCaptureAtCommit(input: CaptureInput, env: NodeJS.ProcessEnv) {
  const url = new URL(import.meta.url);
  const child = fork(url, ["--capture-commit-gate"], {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    env,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  const exited = once(child, "close");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<CaptureGate>((resolve, reject) => {
    deadline = setTimeout(
      () => reject(new Error(stderr || "Capture child did not reach its commit gate")),
      30_000,
    );
    deadline.unref();
    child.once("message", (message: CaptureMessage) => {
      if ("error" in message) {
        reject(new Error(message.error));
      } else {
        resolve(message);
      }
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(stderr || "Capture child exited before its commit gate")),
    );
  });
  try {
    child.send(input);
    const gate = await ready;
    child.kill("SIGKILL");
    const [, signal] = await exited;
    if (signal !== "SIGKILL") {
      throw new Error("Capture child did not stop at its commit gate");
    }
    return gate;
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
}

async function captureUntilCommit(input: CaptureInput) {
  const client = new Client({ connectionString: input.connection });
  try {
    await client.connect();
    const backendPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
      .rows[0]!.pid;
    const { descriptor } = await workboardPortFixture();
    const query = client.query.bind(client);
    let namespace: string | undefined;
    Object.defineProperty(client, "query", {
      value: async (...args: unknown[]) => {
        const text = args[0];
        if (typeof text === "string") {
          const created = /^CREATE SCHEMA "(restore_[a-f0-9]{32})"$/.exec(text);
          if (created) {
            namespace = created[1];
          }
        }
        const commit = text === "COMMIT" && namespace !== undefined;
        const pause = async () => {
          process.send?.({ namespace, backendPid });
          await new Promise<never>(() => {});
        };
        if (commit && input.phase === "before") {
          await pause();
        }
        // Execute every statement through the real client; only the acknowledgement is gated.
        const result: unknown = await Reflect.apply(query, client, args);
        if (commit && input.phase === "after") {
          await pause();
        }
        return result;
      },
    });
    await capturePostgresSchema({
      client,
      descriptor,
      anchor: { engine: "postgres", storeId: input.storeId, namespace: input.namespace },
      directory: input.directory,
      prune: input.prune,
      assertCurrent() {},
    });
    throw new Error("Capture returned without reaching its commit gate");
  } catch (error) {
    process.send?.({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    await client.end();
    process.disconnect?.();
  }
}

if (process.argv[2] === "--capture-commit-gate") {
  // A lost test owner must not leave a child retaining a PostgreSQL transaction.
  process.once("disconnect", () => process.exit(1));
  process.once("message", (input: CaptureInput) => {
    void captureUntilCommit(input);
  });
}
