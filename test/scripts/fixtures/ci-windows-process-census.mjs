import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const metadataPath = (root) => path.join(root, "census.json");

// This witness borrows the operation's deadline, including IPC scheduling time.
function remainingTime(deadline, stage) {
  if (!Number.isSafeInteger(deadline)) {
    throw new Error("Fixture census requires an absolute operation deadline");
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`Census ${stage} ETIMEDOUT (operation deadline expired)`);
  return remaining;
}

function assertLease(root, token) {
  if (fs.readFileSync(path.join(root, "lease"), "utf8") !== token) {
    throw new Error("Fixture census lease retired");
  }
}

function validatePids(pids) {
  if (!Array.isArray(pids) || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
    throw new Error("Fixture census requires explicit positive PIDs");
  }
}

function observationsFor(pids, observations) {
  if (
    !Array.isArray(observations) ||
    observations.length !== pids.length ||
    observations.some(
      (entry, index) =>
        entry?.pid !== pids[index] ||
        typeof entry.alive !== "boolean" ||
        (!(typeof entry.creationTime === "string" && /^\d+$/.test(entry.creationTime)) &&
          !(entry.alive === false && entry.creationTime === null)),
    )
  ) {
    throw new Error("Fixture Windows process census returned invalid identities");
  }
  return new Map(observations.map((entry) => [entry.pid, entry]));
}

function readFrames(stream, receive, fail) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    try {
      if (Buffer.byteLength(buffered) > MAX_FRAME_BYTES) {
        throw new Error("Fixture census frame exceeded its bound");
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        receive(JSON.parse(line));
      }
    } catch (error) {
      fail(error);
    }
  });
  stream.on("end", () => {
    if (buffered) fail(new Error("Truncated fixture census frame"));
  });
  stream.on("error", fail);
}

/** One supervisor owns Python, its streams, and the broker until final census. */
export function createWindowsProcessCensus({ root, token, onFailure }) {
  const child = spawn(
    "python",
    ["-I", "-S", fileURLToPath(new URL("./ci-windows-process-census.py", import.meta.url))],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let closing = false;
  let failure;
  let stderr = "";
  let stderrTruncated = false;
  let childResult;
  let sequence = 0;
  let initialized = false;
  let resolveReady, rejectReady;
  const pending = new Map();
  const sockets = new Map();
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const diagnostics = () =>
    "Fixture Windows process census: " +
    JSON.stringify({
      error: failure?.message,
      errorCode: failure?.code,
      errno: failure?.errno,
      code: childResult?.code,
      signal: childResult?.signal,
      stderr,
      stderrTruncated,
    });
  const rejectPending = (error) => {
    rejectReady(error);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const fail = (error) => {
    if (closing || failure) return;
    failure = error;
    rejectPending(error);
    for (const socket of sockets.keys()) socket.destroy(error);
    child.kill("SIGKILL");
    onFailure(new Error(diagnostics(), { cause: error }));
  };
  const childClosed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      childResult = { code, signal };
      fail(new Error("Census helper closed before retirement"));
      resolve();
    });
  });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    // Drain the bounded traceback through child close; killing on its first chunk
    // can discard the native error and replace its exit status with SIGKILL.
    stderrTruncated ||= stderr.length + chunk.length > MAX_STDERR_CHARS;
    stderr = (stderr + chunk).slice(-MAX_STDERR_CHARS);
  });
  child.stderr.on("error", fail);
  readFrames(
    child.stdout,
    (message) => {
      if (closing || failure) return;
      if (stderr) throw new Error("Census helper wrote stderr");
      if (!initialized) {
        if (message?.ready !== true || Object.keys(message).length !== 1) {
          throw new Error("Invalid census helper readiness");
        }
        initialized = true;
        resolveReady();
        return;
      }
      const request = pending.get(message?.id);
      if (!request || Object.keys(message).length !== 2) {
        throw new Error("Mismatched census helper reply");
      }
      remainingTime(request.deadline, "helper reply");
      const observations = observationsFor(request.pids, message.observations);
      clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(observations);
    },
    fail,
  );
  const read = (pids, deadline) => {
    validatePids(pids);
    if (closing || failure || !initialized) {
      return Promise.reject(failure ?? new Error("Census helper is not ready"));
    }
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const remaining = remainingTime(deadline, "helper query admission");
      const timer = setTimeout(
        () => fail(new Error("Census helper query ETIMEDOUT (operation deadline expired)")),
        remaining,
      );
      pending.set(id, {
        pids: [...pids],
        resolve,
        reject,
        timer,
        deadline,
      });
      child.stdin.write(JSON.stringify({ id, pids }) + "\n", (error) => {
        if (error) fail(error);
      });
    }).then((observations) => {
      if (closing || failure) throw failure ?? new Error("Census owner retired");
      remainingTime(deadline, "helper query completion");
      return observations;
    });
  };
  const server = net.createServer((socket) => {
    if (closing || failure) {
      socket.destroy();
      return;
    }
    const closed = new Promise((resolve) => socket.once("close", resolve));
    sockets.set(socket, closed);
    void closed.then(() => sockets.delete(socket));
    let received = false;
    readFrames(
      socket,
      (request) => {
        if (
          received ||
          closing ||
          failure ||
          request?.token !== token ||
          typeof request.id !== "string"
        ) {
          throw new Error("Invalid or retired census request");
        }
        received = true;
        assertLease(root, token);
        void read(request.pids, request.deadline)
          .then((observations) => {
            assertLease(root, token);
            if (socket.destroyed || closing || failure) return;
            remainingTime(request.deadline, "broker reply publication");
            socket.end(
              JSON.stringify({ id: request.id, observations: [...observations.values()] }) + "\n",
            );
          })
          .catch((error) => socket.destroy(error));
      },
      (error) => socket.destroy(error),
    );
    // Malformed clients cannot keep a broker stream alive through retirement.
    socket.on("error", () => {});
  });
  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", fail);
  const published = Promise.all([ready, listening]).then(() => {
    assertLease(root, token);
    if (closing || failure) throw failure ?? new Error("Census owner retired during startup");
    const endpoint = { token, port: server.address().port };
    const temporary = metadataPath(root) + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(endpoint));
    fs.renameSync(temporary, metadataPath(root));
  });
  void published.catch(() => {});
  let retirement;
  return {
    ready: published,
    read,
    diagnostics,
    close() {
      if (retirement) return retirement;
      closing = true;
      rejectPending(new Error("Census owner retired"));
      for (const socket of sockets.keys()) socket.destroy();
      child.stdin.destroy();
      child.kill("SIGKILL");
      retirement = Promise.all([
        childClosed,
        ...sockets.values(),
        listening.catch(() => {}).then(() => new Promise((resolve) => server.close(resolve))),
      ]).then(() => {
        fs.rmSync(metadataPath(root), { force: true });
      });
      return retirement;
    },
  };
}

/** Actors use the supervisor's sampler, never a fresh interpreter or cached PID identity. */
export async function requestWindowsProcessCensus(root, token, pids, deadline) {
  validatePids(pids);
  assertLease(root, token);
  const endpoint = JSON.parse(fs.readFileSync(metadataPath(root), "utf8"));
  if (
    endpoint.token !== token ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  ) {
    throw new Error("Invalid fixture census endpoint");
  }
  const remaining = remainingTime(deadline, "broker query admission");
  const id = randomUUID();
  const socket = net.createConnection({ host: "127.0.0.1", port: endpoint.port });
  let observations;
  let failure;
  const fail = (error) => {
    failure ??= error;
    socket.destroy();
  };
  const closed = new Promise((resolve, reject) => {
    socket.once("close", () => {
      if (failure || !observations)
        reject(failure ?? new Error("Census broker closed without a reply"));
      else resolve(observations);
    });
  });
  const timer = setTimeout(
    () => fail(new Error("Census broker query ETIMEDOUT (operation deadline expired)")),
    remaining,
  );
  readFrames(
    socket,
    (message) => {
      if (observations || failure || message?.id !== id || Object.keys(message).length !== 2) {
        throw new Error("Mismatched census broker reply");
      }
      remainingTime(deadline, "broker reply");
      observations = observationsFor(pids, message.observations);
    },
    fail,
  );
  socket.once("connect", () => {
    try {
      assertLease(root, token);
      remainingTime(deadline, "broker connection");
      socket.write(JSON.stringify({ id, token, pids, deadline }) + "\n");
    } catch (error) {
      fail(error);
    }
  });
  try {
    const result = await closed;
    remainingTime(deadline, "broker socket close");
    assertLease(root, token);
    return result;
  } finally {
    clearTimeout(timer);
  }
}
