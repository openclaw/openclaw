import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

type FaultStage = "staging-rm" | "read-query" | "copy-open";

export async function installCronSnapshotFaults(
  state: OpenClawTestState,
  coldFailure?: "read" | "copy",
) {
  const sentinel = await state.writeText("snapshot-removal-denied", "deny");
  const receipt = state.statePath("snapshot-fault-receipts.jsonl");
  const fixtureRoot = fs.realpathSync(state.root);
  const header = `
import fs from "node:fs";
import path from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
const sentinel = ${JSON.stringify(sentinel)};
const receipt = ${JSON.stringify(receipt)};
const root = ${JSON.stringify(fixtureRoot)};
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
  const stagingPreload = pathToFileURL(
    await state.writeText(
      "staging-removal-failure.mjs",
      `${header}
import promises from "node:fs/promises";
const remove = promises.rm.bind(promises);
promises.rm = async (target, options) => {
  if (denied() && isSnapshotDirectory(target)) {
    record("staging-rm", "EACCES");
    throw Object.assign(new Error("controlled staging snapshot removal failure"), { code: "EACCES" });
  }
  return await remove(target, options);
};
`,
    ),
  ).href;
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
    cronPreload = pathToFileURL(
      await state.writeText("cron-worker-failure.mjs", header + failure),
    ).href;
  }
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const create = source.create.bind(source);
  const stagingUrl = resolveRuntimeProcessEntrypointUrl("sqliteSnapshotStaging").href;
  const creation = vi.spyOn(source, "create").mockImplementation((filename, options, resource) => {
    if (String(filename) !== stagingUrl) {
      return create(filename, options, resource);
    }
    return create(
      filename,
      { ...options, execArgv: [...(options?.execArgv ?? []), "--import", stagingPreload] },
      resource,
    );
  });
  return {
    cronPreload,
    cronWorkerUrl: resolveRuntimeProcessEntrypointUrl("cronReadOnly").href,
    count(stage: FaultStage): number {
      if (!fs.existsSync(receipt)) {
        return 0;
      }
      return fs
        .readFileSync(receipt, "utf8")
        .trim()
        .split("\n")
        .filter((line) => {
          const value: unknown = JSON.parse(line);
          assert.ok(isRecord(value));
          assert.ok(typeof value.threadId === "number");
          if (value.stage === stage) {
            assert.equal(value.code, stage === "read-query" ? "CONTROLLED_CRON_QUERY" : "EACCES");
            assert.ok(stage === "copy-open" ? value.threadId === 0 : value.threadId > 0);
            return true;
          }
          return false;
        }).length;
    },
    allowRemoval() {
      fs.rmSync(sentinel, { force: true });
    },
    restore() {
      creation.mockRestore();
    },
  };
}
