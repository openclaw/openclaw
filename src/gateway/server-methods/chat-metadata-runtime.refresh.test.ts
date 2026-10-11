import { createServer, get } from "node:http";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { handleGatewayProbeRequest } from "../server-http-probes.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata refresh", () => {
  afterEach(() => {
    setPreparedModelRuntimeStartupStatus(undefined);
  });

  const server = createServer((req, res) => {
    void handleGatewayProbeRequest(
      req,
      res,
      "/health",
      { mode: "none", allowTailscale: false },
      [],
      false,
    );
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  test("serves prepared agents during degraded first publication and adopts the recovered fleet", async () => {
    const config = { agents: { entries: { main: {}, second: {} } } };
    const harness = createChatMetadataHarness(config);
    const mainOwner = createChatMetadataOwner(config, "main-model");
    let secondOwner: ReturnType<typeof createChatMetadataOwner> | undefined;
    harness.getPreparedOwner.mockImplementation((params) =>
      params?.agentId === "second" ? secondOwner : mainOwner,
    );

    try {
      await expect(harness.runtime.refresh()).rejects.toThrow(
        'prepared chat metadata owner is unavailable for agent "second"',
      );
      setPreparedModelRuntimeStartupStatus({
        degraded: true,
        pendingAgents: ["second"],
        stage: "workspace plugins; agent second",
      });
      await harness.runtime.refresh();
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "main-model" })],
      });
      await expect(harness.runtime.read({ agentId: "second" })).rejects.toThrow(
        'prepared chat metadata is unavailable for agent "second"',
      );

      secondOwner = createChatMetadataOwner(config, "second-model");
      setPreparedModelRuntimeStartupStatus({ degraded: false, pendingAgents: [] });
      await harness.runtime.refresh();
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "main-model" })],
      });
      await expect(harness.runtime.read({ agentId: "second" })).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "second-model" })],
      });

      secondOwner = undefined;
      await expect(harness.runtime.refresh()).rejects.toThrow(
        'prepared chat metadata owner is unavailable for agent "second"',
      );
    } finally {
      await harness.runtime.stop();
    }
  });

  test.each(["commands", "projection"] as const)(
    "publishes without fleet preparation and serves health and another agent during slow %s",
    async (phase) => {
      const config = { agents: { entries: { main: {}, second: {} } } };
      const harness = createChatMetadataHarness(config);
      const mainOwner = createChatMetadataOwner(config, "main-model");
      let secondOwner = createChatMetadataOwner(config, "second-model");
      harness.getPreparedOwner.mockImplementation((params) =>
        params?.agentId === "second" ? secondOwner : mainOwner,
      );
      await harness.runtime.refresh();
      expect(harness.buildCommands).not.toHaveBeenCalled();
      expect(harness.buildProjection).not.toHaveBeenCalled();
      const entered = createDeferred();
      const release = createDeferred();
      secondOwner = createChatMetadataOwner(config, "replacement-model");
      if (phase === "commands") {
        harness.buildCommands.mockImplementation(async ({ agentId }) => {
          if (agentId === "second") {
            entered.resolve();
            await release.promise;
          }
          return { commands: [] };
        });
      } else {
        harness.buildProjection.mockImplementation(async ({ facts }) => {
          if (facts.owner === secondOwner) {
            entered.resolve();
            await release.promise;
          }
          return { models: facts.modelCatalog.entries, modelCatalog: facts.modelCatalog.entries };
        });
      }
      const refresh = harness.runtime.refresh();
      let mainSettled = false;
      let secondSettled = false;
      const mainRead = harness.runtime.read({ agentId: "main" }).then((result) => {
        mainSettled = true;
        return result;
      });
      const secondRead = harness.runtime.read({ agentId: "second" }).then((result) => {
        secondSettled = true;
        return result;
      });
      try {
        await entered.promise;
        await nextEventLoopTurn();
        expect(mainSettled).toBe(true);
        expect(secondSettled).toBe(false);
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("health server did not bind a TCP port");
        }
        const health = await new Promise<number | undefined>((resolve, reject) => {
          get(`http://127.0.0.1:${address.port}/health`, (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
          }).on("error", reject);
        });
        expect(health).toBe(200);
        expect(secondSettled).toBe(false);
        await expect(mainRead).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "main-model" })],
        });
        release.resolve();
        await refresh;
        await expect(secondRead).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "replacement-model" })],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([refresh, mainRead, secondRead, harness.runtime.stop()]);
      }
    },
  );

  test("notifies settled catalog status without rebuilding metadata", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, {
      onChanged,
    });
    const owner = harness.getPreparedOwner()!;
    const catalog = owner.modelCatalog;
    try {
      await harness.runtime.refresh();
      const original = await harness.runtime.read({ agentId: "main" });
      onChanged.mockClear();
      catalog.pendingProviders = ["test"];
      await harness.runtime.refresh();
      expect(onChanged).not.toHaveBeenCalled();

      catalog.pendingProviders = undefined;
      await Promise.all([
        harness.runtime.refresh(),
        harness.runtime.refresh({ notifyIfUnchanged: true }),
      ]);
      expect(onChanged).toHaveBeenCalledExactlyOnceWith({
        modelCatalogChanged: true,
        authChanged: false,
        commandsChanged: false,
      });
      expect(await harness.runtime.read({ agentId: "main" })).toEqual(original);
      expect(harness.getPreparedOwner()).toBe(owner);
      expect(owner.modelCatalog).toBe(catalog);
      expect(harness.buildCommands).toHaveBeenCalledOnce();
      expect(harness.buildProjection).toHaveBeenCalledOnce();
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledOnce();

      catalog.refreshFailed = true;
      await Promise.all([
        harness.runtime.refresh(),
        harness.runtime.refresh({ notifyIfUnchanged: true }),
      ]);
      expect(onChanged).toHaveBeenCalledTimes(2);
      expect(onChanged).toHaveBeenLastCalledWith({
        modelCatalogChanged: true,
        authChanged: false,
        commandsChanged: false,
      });
      await harness.runtime.read({ agentId: "main" });
      expect(harness.buildCommands).toHaveBeenCalledTimes(2);
      expect(harness.buildProjection).toHaveBeenCalledTimes(2);
    } finally {
      await harness.runtime.stop();
    }
  });
});

describe("gateway chat metadata shutdown", () => {
  test("closes replacement waiters without publishing or reviving metadata", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    await harness.runtime.refresh();
    harness.runtime.invalidate();
    const reads = [
      harness.runtime.read({ agentId: "main" }),
      harness.runtime.readStartup({
        agentId: "main",
        sessionEntry: { authProfileOverride: "test:session", authProfileOverrideSource: "user" },
      }),
    ].map((read) => read.catch((error: unknown) => error));

    await harness.runtime.stop();

    for (const result of await Promise.all(reads)) {
      expect(result).toMatchObject({
        name: "ChatMetadataSnapshotUnavailableError",
        message: "gateway chat metadata runtime is stopped",
      });
    }
    harness.runtime.invalidate();
    harness.runtime.fail(new Error("late owner failure"));
    await expect(harness.runtime.refresh()).rejects.toThrow("stopped");
    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow("stopped");
    await expect(harness.runtime.readStartup({ agentId: "main" })).resolves.toBeUndefined();
    await harness.runtime.stop();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(harness.buildProjection).not.toHaveBeenCalled();
  });

  test.each(["commands", "projection"] as const)(
    "joins evicted on-demand %s work before shutdown completes",
    async (phase) => {
      const agentIds = Array.from({ length: 66 }, (_, index) => `agent-${index}`);
      const harness = createChatMetadataHarness({
        agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
      });
      const release = createDeferred();
      const entered = createDeferred();
      const events: string[] = [];
      const hold = async () => {
        entered.resolve();
        await release.promise;
        events.push("work settled");
      };
      if (phase === "commands") {
        harness.buildCommands.mockImplementation(async ({ agentId }) => {
          if (agentId === "agent-0") {
            await hold();
          }
          return { commands: [] };
        });
      } else {
        harness.buildProjection.mockImplementation(async ({ facts }) => {
          if (facts.agentId === "agent-0") {
            await hold();
          }
          return { modelCatalog: facts.modelCatalog.entries, models: facts.modelCatalog.entries };
        });
      }
      await harness.runtime.refresh();
      const reading = harness.runtime.read({ agentId: "agent-0" }).catch((error: unknown) => {
        events.push("read settled");
        return error;
      });
      try {
        await entered.promise;
        for (const agentId of agentIds.slice(1)) {
          await harness.runtime.read({ agentId });
        }
        const stopping = harness.runtime.stop().then(() => events.push("shutdown completed"));
        await nextEventLoopTurn();
        expect(events).toEqual([]);
        release.resolve();
        await stopping;
        expect(await reading).toMatchObject({
          message: "gateway chat metadata runtime is stopped",
        });
        expect(events).toEqual(["work settled", "read settled", "shutdown completed"]);
        await expect(harness.runtime.read({ agentId: "agent-0" })).rejects.toThrow("stopped");
      } finally {
        release.resolve();
        await Promise.allSettled([reading, harness.runtime.stop()]);
      }
    },
  );
});
