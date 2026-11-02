import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { installSqliteSnapshotRemovalFault } from "../infra/sqlite-snapshot-removal-fault.test-support.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

type FaultStage = "staging-rm" | "read-query" | "copy-open";

export async function installCronSnapshotFaults(
  state: OpenClawTestState,
  coldFailure?: "read" | "copy",
) {
  const sentinel = await state.writeText("snapshot-removal-denied", "deny");
  const receipt = state.statePath("snapshot-fault-receipts.jsonl");
  const header = `
import fs from "node:fs";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
const sentinel = ${JSON.stringify(sentinel)};
const receipt = ${JSON.stringify(receipt)};
const root = ${JSON.stringify(fs.realpathSync(state.root))};
const denied = () => fs.existsSync(sentinel);
const isSnapshotDirectory = (target) => {
  if (typeof target !== "string" ||
      !path.basename(target).startsWith("openclaw-sqlite-readonly-") ||
      !fs.existsSync(target)) return false;
  const relative = path.relative(root, fs.realpathSync(target));
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const record = (stage, code) => fs.appendFileSync(
  receipt, JSON.stringify({ stage, code, threadId }) + "\\n",
);
`;
  const preload = async (name: string, source: string) =>
    pathToFileURL(await state.writeText(name, header + source)).href;
  const removal = installSqliteSnapshotRemovalFault({
    directory: state.root,
    roots: [state.root],
    code: "EACCES",
  });
  let cronPreload: string | undefined;
  if (coldFailure) {
    const preloadPath = state.statePath("cron-worker-failure.mjs");
    const failure =
      coldFailure === "read"
        ? `
import { DatabaseSync } from "node:sqlite";
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (denied()) {
    const databases = prepare.call(this, "PRAGMA database_list").all();
    if (databases.some((entry) => typeof entry.file === "string" &&
        path.basename(entry.file) === "database.sqlite" &&
        isSnapshotDirectory(path.dirname(entry.file)))) {
      record("read-query", "CONTROLLED_CRON_QUERY");
      throw Object.assign(new Error("controlled cron read query failure"), { code: "CONTROLLED_CRON_QUERY" });
    }
  }
  return prepare.call(this, sql, ...args);
};
`
        : `
import { __setFsSafeTestHooksForTest } from ${JSON.stringify(import.meta.resolve("@openclaw/fs-safe/test-hooks"))};
for (const [name, option] of Object.entries(${JSON.stringify(withRuntimePreload({}, preloadPath))})) {
  process.env[name] = [process.env[name], option].filter(Boolean).join(" ");
}
if (isMainThread) {
  __setFsSafeTestHooksForTest({
    beforeOpen(target) {
      if (denied() && target === ${JSON.stringify(fs.realpathSync(resolveOpenClawStateSqlitePath(state.env)))}) {
        record("copy-open", "EACCES");
        throw Object.assign(new Error("controlled worker snapshot copy failure"), { code: "EACCES" });
      }
    },
  });
}
`;
    cronPreload = await preload("cron-worker-failure.mjs", failure);
  }
  return {
    cronPreload,
    cronWorkerUrl: resolveRuntimeProcessEntrypointUrl("cronReadOnly").href,
    count(stage: FaultStage): number {
      if (stage === "staging-rm") {
        return removal.count();
      }
      const lines = fs.existsSync(receipt)
        ? fs.readFileSync(receipt, "utf8").trim().split("\n")
        : [];
      return lines.reduce((count, line) => {
        const value: unknown = JSON.parse(line);
        assert.ok(isRecord(value) && typeof value.threadId === "number");
        if (value.stage !== stage) {
          return count;
        }
        assert.equal(value.code, stage === "read-query" ? "CONTROLLED_CRON_QUERY" : "EACCES");
        assert.ok(stage === "copy-open" ? value.threadId === 0 : value.threadId > 0);
        return count + 1;
      }, 0);
    },
    allowRemoval() {
      fs.rmSync(sentinel, { force: true });
      removal.allowRemoval();
    },
    restore: () => removal.restore(),
  };
}
