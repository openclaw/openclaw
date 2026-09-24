import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readEmittedModuleRegions } from "../../scripts/lib/emitted-module-regions.mts";
import { createConfigIO } from "../config/io.factory.js";
import { prepareHostConfigSnapshot } from "../config/io.snapshot-preparation.js";
import { registerManagedRuntimeConfigWriteOwner } from "../config/runtime-snapshot.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { recordDeferredPluginMigrations } from "./deferred-plugin-migrations.js";
import * as workerCpu from "./worker-cpu.js";

afterEach(() => vi.restoreAllMocks());

it("reads existing config migration state without loading unrelated worker command families", async () => {
  await withOpenClawTestState({ label: "state-worker-command-loading" }, async (state) => {
    const source = {
      gateway: { mode: "local", port: 18789 },
      plugins: { enabled: false },
      legacyExample: { root: "synthetic-retained-input" },
    };
    await state.writeConfig(source);
    const pending = {
      pluginId: "example",
      reason: "Synthetic pending migration",
      command: "openclaw doctor --fix",
      configPaths: [["legacyExample"]],
      validationExcludedPaths: [["legacyExample"]],
    };
    recordDeferredPluginMigrations({ env: state.env, pending: [pending] });
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const before = fs.readFileSync(databasePath);
    const preload = state.path("observe-worker.cjs");
    const repoRoot = path.resolve(import.meta.dirname, "../..");
    fs.writeFileSync(
      preload,
      `const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { fileURLToPath } = require("node:url");
const { deserialize } = require("node:v8");
const { createHash } = require("node:crypto");
const { isMainThread, parentPort, threadId, MessagePort } = require("node:worker_threads");
if (!isMainThread && parentPort) {
  const loaded = new Set();
  const commands = new Map();
  const root = ${JSON.stringify(repoRoot)};
  const databasePath = ${JSON.stringify(databasePath)};
  const artifacts = () => Object.fromEntries(
    fs.readdirSync(path.dirname(databasePath)).toSorted().map(name => [
      name, createHash("sha256").update(fs.readFileSync(path.join(path.dirname(databasePath), name))).digest("hex"),
    ]),
  );
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.startsWith("file:")) {
      const file = fileURLToPath(url);
      if (file.startsWith(root + path.sep) && !file.includes("/node_modules/")) {
        loaded.add(path.relative(root, file).split(path.sep).join("/"));
      }
    }
    return result;
  }});
  parentPort.on("message", (request) => {
    if (request.type === "execute") {
      const command = deserialize(request.input);
      if (command.type === "plugins.deferredMigrations.read") {
        commands.set(request.id, { command, before: artifacts() });
      }
    }
  });
  const post = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function(message, ...rest) {
    const reply = message?.type === "result" ? message.reply : message;
    if (!reply) return post.call(this, message, ...rest);
    const captured = commands.get(reply.id);
    if (captured && reply.ok) {
      fs.writeFileSync(
        path.join(${JSON.stringify(state.root)}, "command-" + threadId + "-" + reply.id + ".json"),
        JSON.stringify({ ...captured, after: artifacts(), result: deserialize(reply.value), loaded: [...loaded] }),
        { flag: "wx", mode: 0o600 },
      );
    }
    return post.call(this, message, ...rest);
  };
}
`,
    );
    const createWorker = workerCpu.createCpuTrackedWorker;
    vi.spyOn(workerCpu, "createCpuTrackedWorker").mockImplementation((filename, options) =>
      createWorker(filename, {
        ...options,
        execArgv: [...(options?.execArgv ?? []), "--require", preload],
      }),
    );
    const unregister = registerManagedRuntimeConfigWriteOwner(
      state.configPath,
      undefined,
      prepareHostConfigSnapshot,
    );
    try {
      const snapshot = await withArtifactPreservingStateReads(() =>
        createConfigIO({
          env: state.env,
          configPath: state.configPath,
          observe: false,
          shellEnvFallback: "defer",
        }).readConfigFileSnapshot(),
      );
      expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
      expect(snapshot.sourceConfig).toHaveProperty("legacyExample.root", source.legacyExample.root);
      expect(snapshot.config).not.toHaveProperty("legacyExample");
      expect(snapshot.config.gateway?.port).toBe(18789);
      await closeOpenClawStateDatabaseAsync();
      expect(fs.readFileSync(databasePath)).toEqual(before);
      const receipts = fs
        .readdirSync(state.root)
        .filter((name) => name.startsWith("command-"))
        .map((name) => JSON.parse(fs.readFileSync(state.path(name), "utf8")));
      expect(receipts.length).toBeGreaterThan(0);
      for (const receipt of receipts) {
        expect(receipt.after).toEqual(receipt.before);
        expect(receipt).toMatchObject({
          command: {
            type: "plugins.deferredMigrations.read",
            input: { artifactPreservingReadOnly: true },
          },
          result: [pending],
        });
        const owners = receipt.loaded.flatMap((file: string) =>
          file.endsWith(".ts")
            ? [file]
            : readEmittedModuleRegions(fs.readFileSync(path.join(repoRoot, file), "utf8")).map(
                ({ owner }) => owner,
              ),
        );
        expect(owners).toContain("src/infra/deferred-plugin-migrations.worker.ts");
        expect(
          owners.filter((file: string) =>
            [
              "src/skills/workshop/store.worker.ts",
              "src/tasks/task-registry.worker.ts",
              "src/gateway/worker-environments/store.worker.ts",
              "src/infra/device-pairing-dispatch.worker.ts",
              "src/infra/delivery-queue.worker.ts",
              "src/infra/session-delivery-queue.worker.ts",
              "src/cron/store/dispatch.worker.ts",
            ].includes(file),
          ),
        ).toEqual([]);
      }
    } finally {
      unregister();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});
