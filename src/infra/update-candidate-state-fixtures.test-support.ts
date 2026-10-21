import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { runCommandBuffered } from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { prepareUpdateCandidateStateSnapshot } from "./update-candidate-snapshot.js";
import { captureUpdateCandidateDeadline } from "./update-candidate-state.test-support.js";

export function createStateDatabase(file: string, sql: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  using db = openNodeSqliteDatabase(file);
  db.exec(sql);
}

export function useStateReceipts() {
  let channel: FixtureReceiptChannel;
  beforeAll(async () => {
    channel = await openFixtureReceiptChannel();
  });
  afterAll(async () => {
    await channel?.close();
  });
  return {
    get endpoint() {
      return channel.endpoint;
    },
    waitFor: (...args: Parameters<FixtureReceiptChannel["waitFor"]>) => channel.waitFor(...args),
  };
}

export function captureStateOperation<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

export function stateClock() {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
  const expire = captureUpdateCandidateDeadline();
  return (milliseconds: number, expires = false) => {
    elapsed = milliseconds;
    if (expires) {
      expire();
    }
  };
}

export function runStateWorker(
  input: unknown,
  options: Parameters<typeof runCommandBuffered>[1] = {},
  preload?: string,
) {
  return runCommandBuffered(
    [
      process.execPath,
      ...(preload ? ["--import", pathToFileURL(preload).href] : []),
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
      ...options,
      input: JSON.stringify(input),
    },
  );
}

export function snapshotFixture(
  root: string,
  stateDir: string,
  signal: AbortSignal,
  workerEnv: () => NodeJS.ProcessEnv = () => ({
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  }),
) {
  return prepareUpdateCandidateStateSnapshot({
    config: {},
    stateDir,
    candidateRoot: root,
    env: { TMPDIR: root },
    workerEnv,
    signal,
  });
}
