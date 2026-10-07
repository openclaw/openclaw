import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { sqliteWorkerPreloadEnv } from "../infra/sqlite-worker-preload.test-support.js";

export function pauseIntegrityInspections(params: {
  root: string;
  paths: string[];
  pausePaths?: string[];
  pausePreparation?: boolean;
  pauseSchema?: boolean;
}) {
  const releasePath = path.join(params.root, "release-inspection");
  const enteredPaths = params.paths.map((_, index) =>
    path.join(params.root, `inspection-entered-${index}`),
  );
  const preparationReleasePath = `${releasePath}-preparation`;
  const releasePaths = params.paths.map((_, index) => `${releasePath}-${index}`);
  const preparationReleasePaths = releasePaths.map((pathname) => `${pathname}-preparation`);
  const preparationEnteredPaths = enteredPaths.map((pathname) => `${pathname}-preparation`);
  const pausedPaths = params.pausePaths ?? params.paths;
  const preload = path.join(params.root, "pause-inspection.cjs");
  fs.writeFileSync(
    preload,
    `
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { isMainThread, threadId } = require('node:worker_threads');
const paths = ${JSON.stringify(params.paths.map((pathname) => fs.realpathSync.native(pathname)))};
const paused = ${JSON.stringify(params.paths.map((pathname) => pausedPaths.includes(pathname)))};
const preparation = ${params.pausePreparation === true} && (!isMainThread || process.argv[1]?.includes('sqlite-integrity.worker'));
const markers = preparation ? ${JSON.stringify(preparationEnteredPaths)} : ${JSON.stringify(enteredPaths)};
const release = preparation ? ${JSON.stringify(preparationReleasePath)} : ${JSON.stringify(releasePath)};
const releases = preparation ? ${JSON.stringify(preparationReleasePaths)} : ${JSON.stringify(releasePaths)};
let startupInspection = false;
process.on('message', (request) => {
  startupInspection = request?.type === 'inspect' && request.input?.requireStartupMigrationReadiness === true;
});
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function(sql) {
  const location = this.location();
  const selected = ${params.pauseSchema === true} && !preparation ? startupInspection && /PRAGMA user_version/i.test(sql) : /integrity_check/.test(sql);
  const index = selected && location ? paths.indexOf(fs.realpathSync.native(location)) : -1;
  if (index >= 0) {
    // Existence is the shutdown gate; never expose a truncated PID.
    const marker = markers[index];
    const pendingMarker = marker + '.' + process.pid + '.tmp';
    if (!isMainThread) fs.writeFileSync(marker + '.thread', String(threadId));
    fs.writeFileSync(pendingMarker, String(process.pid));
    fs.renameSync(pendingMarker, marker);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 60000;
    while (paused[index] && !fs.existsSync(release) && !fs.existsSync(releases[index])) {
      if (Date.now() > deadline) throw new Error('inspection fixture pause expired');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  return prepare.call(this, sql);
};
`,
  );
  const env = sqliteWorkerPreloadEnv(preload);
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return {
    env,
    releasePath,
    releasePaths,
    enteredPaths,
    preparationReleasePath,
    preparationEnteredPaths,
  };
}
