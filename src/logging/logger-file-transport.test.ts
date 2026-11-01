import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { fileLogTransport } from "./logger-file-transport.js";
import { getLogger, resetLogger, setLoggerOverride } from "./logger.js";
import { registerSecretValueForRedaction } from "./secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "./secret-redaction-registry.test-support.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-file-transport-");
const failedLogPaths = new Set<string>();
let logPath: string;
const read = (file: string) => fs.readFileSync(file, "utf8");
const captureStderr = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const warningLines = (spy: ReturnType<typeof captureStderr>) =>
  spy.mock.calls.map(([line]) => String(line));
function entry(file: string, payload: string, maxFileBytes = 1024 * 1024) {
  return { file, hostname: "transport-test-host", maxFileBytes, payload };
}
function records(file: string): { message?: string; dropped?: number; index?: number }[] {
  return read(file)
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}
function logTo(file: string, message: string) {
  setLoggerOverride({ level: "info", file });
  getLogger().info(message);
}
function failAppends(shouldFail: (file: Parameters<typeof fsPromises.open>[0]) => boolean) {
  const open = fsPromises.open.bind(fsPromises);
  vi.spyOn(fsPromises, "open").mockImplementation(async (file, ...args) => {
    if (shouldFail(file)) {
      throw new Error("injected append failure");
    }
    return open(file, ...args);
  });
}
async function logBatch(...messages: string[]) {
  for (const message of messages) {
    getLogger().info(message);
  }
  await fileLogTransport.flush();
}

function writeStableRecords(): void {
  const logger = getLogger();
  logger.info({ sequence: 1 }, "first queued record");
  logger.info({ sequence: 2 }, "second queued record");
}

beforeAll(async () => {
  await logPathTracker.setup();
  await fileLogTransport.flush();
});

afterEach(async () => {
  await fileLogTransport.flush();
  vi.restoreAllMocks();
  // Successful real writes end fixture failure streaks without clearing the transport owner.
  for (const file of failedLogPaths) {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      fs.rmdirSync(file);
    } else if (stat?.isSymbolicLink() || (stat && stat.nlink > 1)) {
      fs.unlinkSync(file);
    }
    fileLogTransport.enqueue(entry(file, "{}\n"));
  }
  await fileLogTransport.flush();
  failedLogPaths.clear();
  resetLogger();
  resetSecretRedactionRegistryForTest();
  vi.useRealTimers();
});

afterAll(() => logPathTracker.cleanup());
beforeEach(() => {
  logPath = logPathTracker.nextPath();
});

it("writes queued records in order and byte-identically to the synchronous drain", async () => {
  const syncPath = logPathTracker.nextPath();
  const asyncPath = logPathTracker.nextPath();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-27T12:00:00Z"));
  vi.spyOn(os, "hostname").mockReturnValue("transport-test-host");
  setLoggerOverride({ level: "info", file: syncPath });

  writeStableRecords();
  fileLogTransport.drainSync();
  const syncBytes = fs.readFileSync(syncPath);

  resetLogger();
  setLoggerOverride({ level: "info", file: asyncPath });
  writeStableRecords();
  await fileLogTransport.flush();

  expect(fs.readFileSync(asyncPath)).toEqual(syncBytes);
  const messages = records(syncPath).map((record) => record.message);
  expect(messages).toEqual(["first queued record", "second queued record"]);
});

it("drops the oldest records on overflow and writes one count marker", async () => {
  for (let index = 1; index <= 4_098; index += 1) {
    fileLogTransport.enqueue(
      entry(logPath, `${JSON.stringify({ message: `queued-record-${index}` })}\n`),
    );
  }
  await fileLogTransport.flush();

  const written = records(logPath);
  expect(written[0]).toMatchObject({ dropped: 2 });
  expect(written.map((record) => record.message)).toEqual([
    "[openclaw] file log queue overflow; dropped 2 oldest records",
    ...Array.from({ length: 4_096 }, (_, index) => `queued-record-${index + 3}`),
  ]);
});

it.each(["async", "sync"])(
  "preserves rotation and target boundaries in %s batches",
  async (mode) => {
    const firstPath = logPathTracker.nextPath();
    const secondPath = logPathTracker.nextPath();
    const payloads = [1, 2, 3, 4, 5, "x".repeat(128), 7].map(
      (value) => `${JSON.stringify(value)}\n`,
    );
    for (const [index, payload] of payloads.entries()) {
      fileLogTransport.enqueue(
        entry(index === 3 ? secondPath : firstPath, payload, index === 2 ? 4 : 64),
      );
    }
    if (mode === "async") {
      await fileLogTransport.flush();
    } else {
      fileLogTransport.drainSync();
    }

    expect(
      [firstPath, ...[1, 2, 3].map((n) => firstPath.replace(/\.log$/, `.${n}.log`))].map(read),
    ).toEqual([
      payloads[6],
      payloads[5],
      [payloads[2], payloads[4]].join(""),
      payloads.slice(0, 2).join(""),
    ]);
    expect(read(secondPath)).toBe(payloads[3]);
  },
);

it("rescues the unissued tail without replaying an in-flight batch", async () => {
  const [issued, release] = [createDeferred(), createDeferred()] as const;
  let issuedRecords = 0;
  const openFile = fsPromises.open.bind(fsPromises);
  vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await openFile(...args);
    if (args[0] === logPath) {
      const append = handle.appendFile.bind(handle);
      vi.spyOn(handle, "appendFile").mockImplementation(async (...appendArgs) => {
        await append(...appendArgs);
        const content = appendArgs[0];
        assert(typeof content === "string", "Expected a serialized log batch");
        issuedRecords = content.trim().split("\n").length;
        issued.resolve();
        await release.promise;
      });
    }
    return handle;
  });
  const entries = Array.from({ length: 4 }, (_, index) =>
    entry(logPath, `${JSON.stringify({ index, text: "x".repeat(20_000) })}\n`),
  );
  for (const record of entries) {
    fileLogTransport.enqueue(record);
  }
  const flushing = fileLogTransport.flush();
  try {
    await awaitGateBeforeSettlement(
      issued.promise,
      flushing,
      "logger flush completed without reaching the held append",
    );
    expect(issuedRecords).toBeGreaterThan(1);
    fileLogTransport.enqueue(entry(logPath, '{"index":4}\n'));
    fileLogTransport.drainSync();
  } finally {
    release.resolve();
    await flushing;
  }

  expect(records(logPath).map((record) => record.index)).toEqual([0, 1, 2, 3, 4]);
  expect(entries.every((record) => record.payload === "")).toBe(true);
});

it("keeps later exit records separate after a synchronous short write", () => {
  for (const payload of ["first\n", "second\n"]) {
    fileLogTransport.enqueue(entry(logPath, payload, 1024));
  }
  vi.spyOn(fs, "writeSync").mockReturnValueOnce(0);

  fileLogTransport.drainSync();

  expect(read(logPath)).toContain("second\n");
});

for (const kind of ["symlink", "hardlink"]) {
  it.skipIf(kind === "symlink" && process.platform === "win32")(
    `rejects ${kind} targets for batched appends`,
    async () => {
      const target = logPathTracker.nextPath();
      fs.writeFileSync(target, "untouched");
      if (kind === "symlink") {
        fs.symlinkSync(target, logPath);
      } else {
        fs.linkSync(target, logPath);
      }
      failedLogPaths.add(logPath);
      const stderr = captureStderr();
      setLoggerOverride({ level: "info", file: logPath });
      writeStableRecords();
      await fileLogTransport.flush();

      expect(read(target)).toBe("untouched");
      expect(
        warningLines(stderr).filter((line) => line.includes("log file append failed")),
      ).toHaveLength(1);
    },
  );
}

it("warns once per append failure streak and continues with later batches", async () => {
  const secret = "append-warning-secret-1234567890";
  registerSecretValueForRedaction(secret);
  logPath += `-${secret}`;
  let appendAttempts = 0;
  const stderrSpy = captureStderr();
  failedLogPaths.add(logPath);
  failAppends((file) => file === logPath && ++appendAttempts !== 3);
  setLoggerOverride({ level: "info", file: logPath });

  await logBatch("first-dropped-record", "first-dropped-companion");
  await logBatch("second-dropped-record", "second-dropped-companion");
  await logBatch("written-after-failure", "written-companion-after-failure");
  await logBatch("dropped-after-recovery", "dropped-companion-after-recovery");

  expect(appendAttempts).toBe(4);
  expect(records(logPath).map((record) => record.message)).toEqual([
    "written-after-failure",
    "written-companion-after-failure",
  ]);
  const warnings = warningLines(stderrSpy);
  expect(warnings.filter((line) => line.includes("log file append failed"))).toHaveLength(2);
  expect(warnings[0]).toContain("records dropped; check that the path is a writable regular file");
  expect(warnings.join("\n")).not.toContain(secret);
});

it("keeps failure streaks independent by file", async () => {
  const firstPath = logPathTracker.nextPath();
  const secondPath = logPathTracker.nextPath();
  fs.mkdirSync(firstPath);
  fs.mkdirSync(secondPath);
  failedLogPaths.add(firstPath);
  failedLogPaths.add(secondPath);
  const stderrSpy = captureStderr();

  logTo(firstPath, "first-file-failure");
  logTo(secondPath, "second-file-failure");
  await fileLogTransport.flush();

  fs.rmdirSync(secondPath);
  getLogger().info("second-file-recovery");
  logTo(firstPath, "first-file-repeated-failure");
  await fileLogTransport.flush();

  const warnings = warningLines(stderrSpy);
  expect(warnings.filter((line) => line.includes(`file=${firstPath}`))).toHaveLength(1);
  expect(warnings.filter((line) => line.includes(`file=${secondPath}`))).toHaveLength(1);
  expect(read(secondPath)).toContain("second-file-recovery");
});

// A deleted directory reached through its open descriptor mirrors a stale mounted
// /tmp: children fail with ENOENT while the parent path still resolves, the shape
// on which Node's recursive mkdirSync never returns.
it.skipIf(process.platform !== "linux")(
  "drops records with a warning when the log directory parent is deleted but still resolvable",
  async () => {
    const deletedDir = logPathTracker.nextPath();
    fs.mkdirSync(deletedDir);
    const fd = fs.openSync(deletedDir, "r");
    try {
      fs.rmdirSync(deletedDir);
      logPath = `/proc/self/fd/${fd}/openclaw/openclaw.log`;
      const stderrSpy = captureStderr();
      logTo(logPath, "only-record-after-deletion");
      await fileLogTransport.flush();

      const warnings = warningLines(stderrSpy);
      expect(warnings.some((line) => line.includes(`file=${logPath}`))).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
  },
);

it("writes a piped append warning before process exit", () => {
  fs.mkdirSync(logPath);
  const loaderPath = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
  const loggerUrl = new URL("./logger.ts", import.meta.url).href;
  const script = `
      import { getLogger, setLoggerOverride } from ${JSON.stringify(loggerUrl)};
      const writeStderr = process.stderr.write.bind(process.stderr);
      process.stderr.write = (chunk, ...args) => {
        setImmediate(() => writeStderr(chunk, ...args));
        return true;
      };
      setLoggerOverride({ level: "info", file: ${JSON.stringify(logPath)}, consoleStyle: "compact" });
      getLogger().info("exit-dropped-record");
      process.exit(0);
    `;

  const args = ["--import", loaderPath, "--input-type=module", "--eval", script];
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, VITEST: "false" },
  });

  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toContain("log file append failed; records dropped");
});

it("retries the warning after stderr rejects it", async () => {
  const stderrSpy = captureStderr();
  stderrSpy.mockImplementationOnce(() => {
    throw new Error("injected stderr failure");
  });
  failedLogPaths.add(logPath);
  failAppends((file) => file === logPath);
  setLoggerOverride({ level: "info", file: logPath });

  await logBatch("first-dropped-record");
  await logBatch("second-dropped-record");

  expect(stderrSpy).toHaveBeenCalledTimes(2);
  expect(String(stderrSpy.mock.calls[1]?.[0])).toContain(`file=${logPath}`);
});

it("releases saturated failure tracking after a tracked file recovers", async () => {
  const paths = Array.from({ length: 65 }, () => logPathTracker.nextPath());
  const firstPath = paths[0]!;
  const lastPath = paths[64]!;
  const stderrSpy = captureStderr();
  const targets = new Set(paths);
  paths.forEach((file) => failedLogPaths.add(file));
  let recoveringFirstPath = false;
  failAppends(
    (file) =>
      typeof file === "string" && targets.has(file) && !(recoveringFirstPath && file === firstPath),
  );

  for (const [index, file] of paths.entries()) {
    logTo(file, `failure-${index}`);
  }
  await fileLogTransport.flush();

  const warnings = warningLines(stderrSpy);
  expect(warnings.filter((line) => line.includes("diagnostics saturated"))).toHaveLength(1);
  expect(warnings.some((line) => line.includes(`file=${lastPath}`))).toBe(false);

  recoveringFirstPath = true;
  logTo(firstPath, "tracked-file-recovery");
  logTo(lastPath, "newly-tracked-failure");
  await fileLogTransport.flush();

  expect(stderrSpy.mock.calls.some(([line]) => String(line).includes(`file=${lastPath}`))).toBe(
    true,
  );
});
