import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { serialize } from "node:v8";
import { createPermitPool } from "../../shared/permit-pool.js";
import { ensureSqliteLibrarySelected } from "../bun-sqlite-library.js";
import { runtimeProcessEntrypoints } from "../runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../sqlite-handle-lifecycle.js";
import type { VectorKnnChildInput } from "./sqlite-vector.child.js";
import type { SqliteVectorPlan, VectorKnnResponse } from "./sqlite-vector.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const KILL_EXIT_TIMEOUT_MS = 2_000;
const MAX_CONCURRENT_VECTOR_KNN_CHILDREN = 2;

class VectorKnnSubprocessError extends Error {
  constructor(
    message: string,
    readonly code: "unavailable" | "failed" | "protocol" | "termination-timeout",
  ) {
    super(message);
    this.name = "VectorKnnSubprocessError";
  }
}

function buildChildEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[name]) {
      childEnv[name] = process.env[name];
    }
  }
  return childEnv;
}

function toAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("memory vector KNN aborted");
}

const vectorKnnAdmission = createPermitPool(MAX_CONCURRENT_VECTOR_KNN_CHILDREN);
const databaseAdmissions = new Map<
  string,
  { admission: ReturnType<typeof createPermitPool>; users: number }
>();
const children = new Map<
  string,
  {
    child: ChildProcessWithoutNullStreams;
    idleTimer?: ReturnType<typeof setTimeout>;
    retire: () => void;
  }
>();

function setChildReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean) {
  const method = referenced ? "ref" : "unref";
  child[method]();
  for (const pipe of [child.stdin, child.stdout, child.stderr]) {
    // Node and Bun expose different pipe classes and optional ref methods.
    if (referenced && "ref" in pipe && typeof pipe.ref === "function") {
      pipe.ref();
    }
    if (!referenced && "unref" in pipe && typeof pipe.unref === "function") {
      pipe.unref();
    }
  }
}

function parseChildResult<Row>(
  output: Buffer,
  maxRows: number,
  isRow: (value: unknown) => value is Row,
): VectorKnnResponse<Row> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.toString("utf8"));
  } catch {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned malformed JSON",
      "protocol",
    );
  }
  if (!parsed || typeof parsed !== "object" || !("status" in parsed)) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid envelope",
      "protocol",
    );
  }
  if (parsed.status === "failed" && "error" in parsed && typeof parsed.error === "string") {
    throw new VectorKnnSubprocessError(parsed.error || "memory vector KNN child failed", "failed");
  }
  const value = "value" in parsed ? parsed.value : undefined;
  if (
    parsed.status !== "ok" ||
    !value ||
    typeof value !== "object" ||
    !("rows" in value) ||
    !Array.isArray(value.rows) ||
    value.rows.length > maxRows ||
    !value.rows.every(isRow) ||
    !("fallbackScanRequired" in value) ||
    typeof value.fallbackScanRequired !== "boolean"
  ) {
    throw new VectorKnnSubprocessError(
      "memory vector KNN child returned an invalid result",
      "protocol",
    );
  }
  return { rows: value.rows, fallbackScanRequired: value.fallbackScanRequired };
}

type VectorKnnSubprocessParams<Row> = {
  databasePath: string;
  extensionPath?: string;
  request: SqliteVectorPlan;
  isRow: (value: unknown) => value is Row;
  signal?: AbortSignal;
};

/** Run one file-backed KNN query in a bounded, OS-killable child process. */
export async function runVectorKnnInSubprocess<Row>(
  params: VectorKnnSubprocessParams<Row>,
): Promise<VectorKnnResponse<Row>> {
  let entry = databaseAdmissions.get(params.databasePath);
  if (!entry) {
    entry = { admission: createPermitPool(1), users: 0 };
    databaseAdmissions.set(params.databasePath, entry);
  }
  entry.users += 1;
  let release: (() => void) | undefined;
  try {
    release = (await entry.admission.acquire({ signal: params.signal })) ?? undefined;
    if (!release) {
      throw toAbortError(params.signal!);
    }
    return await runAdmittedVectorKnn(params);
  } finally {
    release?.();
    if (--entry.users === 0) {
      databaseAdmissions.delete(params.databasePath);
    }
  }
}

async function runAdmittedVectorKnn<Row>(
  params: VectorKnnSubprocessParams<Row>,
): Promise<VectorKnnResponse<Row>> {
  if (params.signal?.aborted) {
    throw toAbortError(params.signal);
  }
  const sqliteLibrary = ensureSqliteLibrarySelected();
  const input: VectorKnnChildInput = {
    databasePath: params.databasePath,
    extensionPath: params.extensionPath,
    ...(sqliteLibrary.source !== "runtime" ? { sqliteLibraryPath: sqliteLibrary.path } : {}),
    request: serialize(params.request).toString("base64"),
  };
  const inputPayload = Buffer.from(JSON.stringify(input), "utf8");
  if (inputPayload.byteLength > MAX_STDIN_BYTES) {
    throw new VectorKnnSubprocessError("memory vector KNN child input is too large", "protocol");
  }

  let worker = children.get(params.databasePath);
  if (!worker) {
    let permit = vectorKnnAdmission.tryAcquire();
    if (!permit) {
      const idleWorker = [...children.values()].find((candidate) => candidate.idleTimer);
      if (idleWorker) {
        idleWorker.retire();
      }
      permit = await vectorKnnAdmission.acquire({ signal: params.signal });
    }
    if (!permit) {
      throw toAbortError(params.signal!);
    }
    const releaseAdmission = permit;
    if (params.signal?.aborted) {
      releaseAdmission();
      throw toAbortError(params.signal);
    }
    let child;
    try {
      const childUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sqliteVector);
      child = spawn(process.execPath, resolveRuntimeWorkerArgv(childUrl), {
        env: buildChildEnv(),
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      releaseAdmission();
      throw new VectorKnnSubprocessError(
        error instanceof Error ? error.message : String(error),
        "unavailable",
      );
    }
    worker = {
      child,
      retire: () => {
        if (children.get(params.databasePath) !== ownedWorker) {
          return;
        }
        // A waiter can arrive after any retirement, including the idle timer.
        setChildReferenced(child, true);
        children.delete(params.databasePath);
        clearTimeout(ownedWorker.idleTimer);
        child.stdin.destroy();
        child.kill("SIGKILL");
      },
    };
    const ownedWorker = worker;
    child.once("close", () => {
      clearTimeout(ownedWorker.idleTimer);
      if (children.get(params.databasePath) === ownedWorker) {
        children.delete(params.databasePath);
      }
      releaseAdmission();
    });
    child.on("error", ownedWorker.retire);
    child.stdin.on("error", ownedWorker.retire);
    children.set(params.databasePath, worker);
  }
  const { child } = worker;
  const ownedWorker = worker;
  clearTimeout(worker.idleTimer);
  worker.idleTimer = undefined;
  child.stdout.removeAllListeners("data");
  setChildReferenced(child, true);
  return await new Promise<VectorKnnResponse<Row>>((resolve, reject) => {
    const stderrChunks: Buffer[] = [];
    let closed = false;
    let callerSettled = false;
    let terminationReason: Error | undefined;
    let killExitTimer: ReturnType<typeof setTimeout> | undefined;

    const settleCaller = (action: () => void) => {
      if (callerSettled) {
        return;
      }
      callerSettled = true;
      params.signal?.removeEventListener("abort", abort);
      child.stdout.removeAllListeners("data");
      child.stderr.removeAllListeners("data");
      child.stdin.removeListener("error", onStdinError);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      action();
    };
    const requestTermination = (reason: Error) => {
      if (terminationReason || closed) {
        return;
      }
      terminationReason = reason;
      // This read-only Node child creates no descendants. Kill the owned handle:
      // native SQLite cannot service graceful shutdown while its query is busy.
      ownedWorker.retire();
      killExitTimer = setTimeout(() => {
        if (!closed) {
          // The caller may return, but this child keeps its admission slot until
          // close. Destroying pipes and unref'ing prevents one unkillable OS task
          // from pinning the Gateway while the slot bounds future accumulation.
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          settleCaller(() =>
            reject(
              new VectorKnnSubprocessError(
                "memory vector KNN child did not exit after SIGKILL",
                "termination-timeout",
              ),
            ),
          );
        }
      }, KILL_EXIT_TIMEOUT_MS);
    };
    const abort = () => {
      requestTermination(toAbortError(params.signal!));
    };

    params.signal?.addEventListener("abort", abort, { once: true });
    if (params.signal?.aborted) {
      abort();
    }
    for (const stream of ["stdout", "stderr"] as const) {
      const chunks: Buffer[] = stream === "stderr" ? stderrChunks : [];
      const maxBytes = stream === "stdout" ? MAX_STDOUT_BYTES : MAX_STDERR_BYTES;
      let bytes = 0;
      child[stream].on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        const frameBytes = stream === "stdout" && chunk[chunk.length - 1] === 10 ? 1 : 0;
        if (bytes > maxBytes + frameBytes) {
          if (stream === "stdout") {
            chunks.length = 0;
          }
          requestTermination(
            new VectorKnnSubprocessError(
              `memory vector KNN child ${stream} exceeded its limit`,
              "protocol",
            ),
          );
          return;
        }
        chunks.push(chunk);
        if (stream === "stderr") {
          return;
        }
        const newline = chunk.indexOf(10);
        if (newline < 0) {
          return;
        }
        try {
          if (newline !== chunk.length - 1) {
            throw new VectorKnnSubprocessError(
              "memory vector KNN child returned extra output",
              "protocol",
            );
          }
          const result = parseChildResult(
            Buffer.concat(chunks),
            params.request.limit,
            params.isRow,
          );
          if (terminationReason) {
            return;
          }
          settleCaller(() => resolve(result));
          child.stdout.on("data", ownedWorker.retire);
          ownedWorker.idleTimer = setTimeout(ownedWorker.retire, SQLITE_IDLE_HANDLE_TTL_MS);
          ownedWorker.idleTimer.unref();
          if (vectorKnnAdmission.pendingCount > 0) {
            ownedWorker.retire();
          } else {
            setChildReferenced(child, false);
          }
        } catch (error) {
          requestTermination(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    const onStdinError = (error: NodeJS.ErrnoException) => {
      if (!terminationReason && error.code !== "EPIPE") {
        requestTermination(new VectorKnnSubprocessError(error.message, "failed"));
      }
    };
    child.stdin.on("error", onStdinError);
    const onError = (error: Error) => {
      requestTermination(new VectorKnnSubprocessError(error.message, "unavailable"));
    };
    child.once("error", onError);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      closed = true;
      // close is the authoritative process/stdio completion; a recycled numeric
      // PID must not turn a successful query into a false cleanup failure.
      if (killExitTimer) {
        clearTimeout(killExitTimer);
        killExitTimer = undefined;
      }
      params.signal?.removeEventListener("abort", abort);
      settleCaller(() => {
        if (terminationReason) {
          reject(terminationReason);
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new VectorKnnSubprocessError(
            `memory vector KNN child exited before returning a result (code ${code}, signal ${signal ?? "none"})${stderr ? `: ${stderr}` : ""}`,
            "failed",
          ),
        );
      });
    };
    child.once("close", onClose);
    child.stdin.write(Buffer.concat([inputPayload, Buffer.from("\n")]));
  });
}
