// Real generation cleanup scenarios share the owning suite’s loader and scoped state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../agents/prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectErrorGraphCandidates } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getPluginInstance, type PluginInstanceHandle } from "./plugin-instance-scope.js";
import { createColdPluginFixture } from "./test-helpers/cold-plugin-fixtures.js";

function hasCause(error: unknown, message: string): boolean {
  return collectErrorGraphCandidates(error, (candidate) => [
    candidate.cause,
    candidate.error,
    candidate.suppressed,
    ...(Array.isArray(candidate.errors) ? candidate.errors : []),
  ]).some((candidate) => candidate instanceof Error && candidate.message === message);
}

function createFixture(state: OpenClawTestState, id: string, failure?: string) {
  const root = state.path(id);
  fs.mkdirSync(root);
  const fixture = createColdPluginFixture({ rootDir: root, pluginId: id, providerId: id });
  const event = `${id}:${state.root}`;
  const disposed = path.join(root, "disposed.txt");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const onCleanup = (resume: () => void) => {
    entered.resolve();
    void release.promise.then(resume);
  };
  process.on(event, onCleanup);
  fs.writeFileSync(
    fixture.runtimeSource,
    `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(id)}, label: "Retirement fixture", auth: [] });
  api.registerService({ get id() { api.lifecycle.signal.throwIfAborted(); return ${JSON.stringify(id)}; }, start() {}, stop() {} });
  api.lifecycle.onDispose(async () => {
    await new Promise(resolve => process.emit(${JSON.stringify(event)}, resolve));
    fs.appendFileSync(${JSON.stringify(disposed)}, "disposed\\n");
    ${failure ? `throw new Error(${JSON.stringify(failure)});` : ""}
  });
} };`,
  );
  const config: OpenClawConfig = {
    agents: {
      list: [{ id, default: true, workspace: state.workspaceDir }],
      defaults: { model: `${id}/local` },
    },
    models: {
      providers: {
        [id]: {
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "synthetic-unused",
          models: [
            {
              id: "local",
              name: "Local",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1024,
            },
          ],
        },
      },
    },
    plugins: {
      allow: [id],
      load: { paths: [root] },
      entries: { [id]: { enabled: true } },
      slots: { memory: "none" },
    },
  };
  return {
    id,
    config,
    entered,
    release,
    disposed,
    close() {
      release.resolve();
      process.off(event, onCleanup);
    },
  };
}

type Fixture = ReturnType<typeof createFixture>;
async function acquire(state: OpenClawTestState, fixture: Fixture) {
  const lease = await acquireAgentRunPreparedModelRuntime(
    {
      config: fixture.config,
      agentId: fixture.id,
      agentDir: state.agentDir(fixture.id),
      workspaceDir: state.workspaceDir,
      env: state.env,
      skipCredentials: true,
    },
    { catalogMode: "static" },
  );
  const service = lease.snapshot.pluginRegistry?.services.find(
    (entry) => entry.pluginId === fixture.id,
  )?.service;
  assert.ok(service, JSON.stringify(lease.snapshot.pluginRegistry?.diagnostics));
  assert.equal(service.id, fixture.id);
  return lease;
}

export async function verifyPreparedModelGenerationCleanup(scenario: "publication" | "arrivals") {
  await withOpenClawTestState(
    { label: "retirement-observation", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const failure = "synthetic generation disposal failure";
      const fixtures: Fixture[] = [];
      const completions: Promise<unknown>[] = [];
      const failed = createFixture(state, "failed-retirement", failure);
      fixtures.push(failed);
      let lease: Awaited<ReturnType<typeof acquire>> | undefined;
      let instance: PluginInstanceHandle | undefined;
      const observeFailure = (promise: Promise<unknown>) => {
        const observed = promise.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        completions.push(observed);
        return observed;
      };
      try {
        lease = await acquire(state, failed);
        const service = lease.snapshot.pluginRegistry!.services.find(
          (entry) => entry.pluginId === failed.id,
        )!.service;
        const record = lease.snapshot.pluginRegistry!.plugins.find(
          (entry) => entry.id === failed.id,
        )!;
        instance = getPluginInstance(record);
        assert.ok(instance);
        if (scenario === "publication") {
          const disposed = observeFailure(lease[Symbol.asyncDispose]());
          await failed.entered.promise;
          failed.release.resolve();
          const cleanup = await disposed;
          assert.equal(cleanup.ok, true);
          assert.ok((await instance.dispose()).errors.some((error) => hasCause(error, failure)));
          assert.throws(() => service.id, /retir|reload|disabled/);
          const healthy: OpenClawConfig = {
            agents: { list: [{ id: "healthy", default: true, workspace: state.workspaceDir }] },
            plugins: { enabled: false, slots: { memory: "none" } },
          };
          await refreshPreparedModelRuntimeSnapshots(healthy, {
            catalogMode: "static",
            gatewayLifecycle: true,
          });
          const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "healthy" });
          assert.ok(published, "The healthy configured owner must be published");
          assert.equal(
            published.config,
            healthy,
            "An unrelated healthy batch must publish after observed cleanup failure",
          );
        } else {
          assert.equal(scenario, "arrivals");
          const first = createFixture(state, "first-retirement");
          fixtures.push(first);
          const firstLease = await acquire(state, first);
          const firstDisposal = observeFailure(firstLease[Symbol.asyncDispose]());
          await first.entered.promise;
          let terminalSettled = false;
          const terminal = observeFailure(closePreparedModelRuntimeSnapshots()).then((result) => {
            terminalSettled = true;
            return result;
          });
          const laterDisposal = observeFailure(lease[Symbol.asyncDispose]());
          await failed.entered.promise;
          first.release.resolve();
          assert.equal((await firstDisposal).ok, true);
          await nextTurn();
          assert.equal(
            terminalSettled,
            false,
            "Terminal close retains cleanup whose final borrower releases while it waits",
          );
          failed.release.resolve();
          assert.equal((await terminal).ok, true);
          assert.equal((await laterDisposal).ok, true);
        }
      } finally {
        fixtures.forEach((fixture) => fixture.release.resolve());
        await Promise.allSettled([...completions, lease?.[Symbol.asyncDispose]()]);
        try {
          const terminal = await observeFailure(closePreparedModelRuntimeSnapshots());
          assert.equal(
            terminal.ok,
            true,
            "Reported plugin cleanup faults must not poison process close",
          );
          if (instance) {
            assert.ok((await instance.dispose()).errors.some((error) => hasCause(error, failure)));
            assert.equal(
              fs.readFileSync(failed.disposed, "utf8"),
              "disposed\n",
              "Cleanup runs once across repeated observation and process close",
            );
          }
        } finally {
          fixtures.forEach((fixture) => fixture.close());
        }
      }
    },
  );
}
