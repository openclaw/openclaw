import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPluginRecord,
  createPluginRuntimeMock,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { bundledPluginRoot } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import codexPlugin from "../extensions/codex/index.js";
import { invokeRegisteredNodeHostCommand } from "../src/node-host/plugin-node-host.js";
import { loadPluginManifest } from "../src/plugins/manifest.js";
import { createRuntimeTestRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { runWithSpawnBroker } from "../src/process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../src/process/spawn-broker/host.js";
import { isPidDefinitelyDead } from "../src/shared/pid-alive.js";
import { createDeferred, withTestTimeout } from "./helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const bufferedObservation = vi.hoisted(() => ({ returned: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    async runCommandBuffered(...args: Parameters<typeof actual.runCommandBuffered>) {
      const result = await actual.runCommandBuffered(...args);
      bufferedObservation.returned(result);
      return result;
    },
  };
});

const wait = <T>(work: PromiseLike<T>, message: string) => withTestTimeout(work, 5_000, message);

afterEach(() => {
  resetPluginRuntimeStateForTest();
  bufferedObservation.returned.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

it.skipIf(skipBrokerTests)(
  "keeps the session reserved until canceled late-PID work has closed",
  async () => {
    const root = tempDirs.make("codex-node-cleanup-");
    const codexHome = path.join(root, "codex-home");
    await fs.mkdir(codexHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
    const pluginConfig = { sessionCatalog: { enabled: false } };
    const config = { plugins: { entries: { codex: { enabled: true, config: pluginConfig } } } };
    const registry = createRuntimeTestRegistry(
      createPluginRuntimeMock({ config: { current: () => config } }),
    );
    const codexManifest = loadPluginManifest(bundledPluginRoot("codex"));
    if (!codexManifest.ok) {
      throw new Error(codexManifest.error);
    }
    const record = createPluginRecord({
      id: "codex",
      source: path.join(root, "index.js"),
      nativeSessionCatalog: codexManifest.manifest.setup?.nativeSessionCatalog,
    });
    codexPlugin.register(registry.createApi(record, { config, pluginConfig }));
    setActivePluginRegistry(registry.registry);

    const broker = createSpawnBrokerHost();
    const controller = new AbortController();
    const remoteRequested = createDeferred<ReturnType<SpawnBrokerHost["spawnExeca"]>>();
    const bufferedReturned = createDeferred();
    const remotes: Array<ReturnType<SpawnBrokerHost["spawnExeca"]>> = [];
    const invocations: Promise<unknown>[] = [];
    const failures: unknown[] = [];
    const retainFailure = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    let brokerStopped = false;
    const resumeBroker = () => {
      if (brokerStopped && broker.pid !== undefined) {
        process.kill(broker.pid, "SIGCONT");
        brokerStopped = false;
      }
    };
    try {
      await broker.ready();
      if (broker.pid === undefined) {
        throw new Error("spawn broker did not report its PID");
      }
      const spawnExeca = broker.spawnExeca.bind(broker);
      vi.spyOn(broker, "spawnExeca").mockImplementation((argv, options) => {
        const outputIndex = argv.indexOf("--output-last-message");
        const outputPath = argv[outputIndex + 1];
        if (outputIndex === -1 || !outputPath) {
          throw new Error("fixture received an unexpected process request");
        }
        const source = `
          const fs = require("node:fs");
          if (fs.readFileSync(0, "utf8") === "retry") {
            fs.writeFileSync(process.argv[1], "retry completed");
          } else {
            setInterval(() => {}, 1_000);
          }
        `;
        const remote = spawnExeca([process.execPath, "-e", source, outputPath], options);
        remotes.push(remote);
        remoteRequested.resolve(remote);
        return remote;
      });
      bufferedObservation.returned.mockImplementation(() => bufferedReturned.resolve());
      const invoke = (prompt: string, signal?: AbortSignal) => {
        const invocation = runWithSpawnBroker(broker, () =>
          invokeRegisteredNodeHostCommand(
            "codex.cli.session.resume",
            JSON.stringify({
              sessionId: "cleanup-fixture-session",
              prompt,
              cwd: root,
              timeoutMs: 10_000,
            }),
            undefined,
            { signal, sendNodeEvent: async () => undefined },
          ),
        );
        invocations.push(invocation);
        void invocation.catch(() => {});
        return invocation;
      };
      process.kill(broker.pid, "SIGSTOP");
      brokerStopped = true;
      const first = invoke("hold", controller.signal);
      const outcome = first.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      const remote = await wait(
        remoteRequested.promise,
        "registered command did not reach the broker",
      );
      expect(remote.child.pid).toBeUndefined();
      controller.abort(new Error("node invocation canceled"));
      await wait(
        bufferedReturned.promise,
        "buffered execution did not expose its bounded cancellation result",
      );
      expect(
        await Promise.race([outcome, delay(250).then(() => ({ kind: "pending" as const }))]),
      ).toEqual({ kind: "pending" });
      await expect(invoke("retry")).rejects.toThrow("already has an active resume turn");

      resumeBroker();
      await wait(remote.child.waitForClose(), "late native child did not close");
      expect(remote.child.pid).toBeDefined();
      expect(isPidDefinitelyDead(remote.child.pid!)).toBe(true);
      expect(await wait(outcome, "registered cancellation did not settle")).toMatchObject({
        kind: "rejected",
        error: { message: "node invocation canceled" },
      });
      const retry = await wait(invoke("retry"), "session remained reserved after cleanup");
      expect(JSON.parse(retry ?? "null")).toMatchObject({
        ok: true,
        sessionId: "cleanup-fixture-session",
        text: "retry completed",
      });
    } catch (error) {
      failures.push(error);
    } finally {
      controller.abort();
      await retainFailure(async () => {
        resumeBroker();
        await Promise.all(
          remotes.map((remote) =>
            retainFailure(async () => {
              await wait(remote.child.ready(), "cleanup could not obtain late PID").catch(
                () => undefined,
              );
              remote.child.kill("SIGKILL");
              await wait(remote.result, "fixture process did not settle").catch(() => undefined);
              await wait(remote.child.waitForClose(), "fixture child did not close");
            }),
          ),
        );
      });
      await retainFailure(() => broker.close());
      await retainFailure(() =>
        wait(Promise.allSettled(invocations), "registered invocations did not settle"),
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "registered cancellation fixture failed");
    }
  },
);
