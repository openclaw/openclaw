import { createServer, get } from "node:http";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { handleGatewayProbeRequest } from "../server-http-probes.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

function fleet() {
  const config = { agents: { entries: { main: {}, second: {} } } };
  const harness = createChatMetadataHarness(config);
  const main = createChatMetadataOwner(config, "main-model");
  let second: ReturnType<typeof createChatMetadataOwner> | undefined;
  harness.getPreparedOwner.mockImplementation((params) =>
    params?.agentId === "second" ? second : main,
  );
  return {
    ...harness,
    replaceSecond(id?: string) {
      second = id ? createChatMetadataOwner(config, id) : undefined;
    },
  };
}

function holdPreparation(
  harness: ReturnType<typeof createChatMetadataHarness>,
  phase: "commands" | "projection",
  agentId: string,
  settled = () => {},
) {
  const entered = createDeferred();
  const release = createDeferred();
  const hold = async (id: string) => {
    if (id === agentId) {
      entered.resolve();
      await release.promise;
      settled();
    }
  };
  if (phase === "commands") {
    harness.buildCommands.mockImplementation(async ({ agentId: id }) => {
      await hold(id);
      return { commands: [] };
    });
  } else {
    harness.buildProjection.mockImplementation(async ({ facts }) => {
      await hold(facts.agentId);
      return { models: facts.modelCatalog.entries, modelCatalog: facts.modelCatalog.entries };
    });
  }
  return { entered, release };
}

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

  test("serves published agents independently of missing owners and adopts the recovered fleet", async () => {
    const harness = fleet();
    onTestFinished(() => harness.runtime.stop());

    await harness.refresh();
    await expect(harness.read()).resolves.toMatchObject({ models: [{ id: "main-model" }] });
    for (const [id, degraded] of [
      [undefined, true],
      ["second-model", false],
      [undefined, false],
    ] as const) {
      harness.replaceSecond(id);
      setPreparedModelRuntimeStartupStatus({
        degraded,
        pendingAgents: degraded ? ["second"] : [],
        ...(degraded ? { stage: "workspace plugins; agent second" } : {}),
      });
      await harness.refresh();
      await expect(harness.read()).resolves.toMatchObject({ models: [{ id: "main-model" }] });
      const second = expect(harness.read({ agentId: "second" }));
      if (id) {
        await second.resolves.toMatchObject({ models: [{ id }] });
      } else {
        await second.rejects.toThrow('prepared chat metadata is unavailable for agent "second"');
      }
    }
  });

  test.each(["commands", "projection"] as const)(
    "publishes without fleet preparation and serves health and another agent during slow %s",
    async (phase) => {
      const harness = fleet();
      harness.replaceSecond("second-model");
      await harness.refresh();
      expect(harness.buildCommands).not.toHaveBeenCalled();
      expect(harness.buildProjection).not.toHaveBeenCalled();
      harness.replaceSecond("replacement-model");
      const { entered, release } = holdPreparation(harness, phase, "second");
      const refresh = harness.refresh();
      let mainSettled = false;
      let secondSettled = false;
      const mainRead = harness.read().then((result) => {
        mainSettled = true;
        return result;
      });
      const secondRead = harness.read({ agentId: "second" }).then((result) => {
        secondSettled = true;
        return result;
      });
      try {
        await entered.promise;
        await nextEventLoopTurn();
        expect({ mainSettled, secondSettled }).toEqual({ mainSettled: true, secondSettled: false });
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
        await expect(mainRead).resolves.toMatchObject({ models: [{ id: "main-model" }] });
        release.resolve();
        await refresh;
        await expect(secondRead).resolves.toMatchObject({ models: [{ id: "replacement-model" }] });
      } finally {
        release.resolve();
        await Promise.allSettled([refresh, mainRead, secondRead, harness.runtime.stop()]);
      }
    },
  );

  test("retains a requested status notification when refreshes coalesce", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    onTestFinished(() => harness.runtime.stop());
    await harness.refresh();
    onChanged.mockClear();
    await Promise.all([harness.refresh(), harness.refresh({ notifyIfUnchanged: true })]);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      modelCatalogChanged: false,
      modelCatalogStatusChanged: true,
      authChanged: false,
      commandsChanged: false,
    });
  });
});

describe("gateway chat metadata shutdown", () => {
  test("closes replacement waiters without publishing or reviving metadata", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    await harness.refresh();
    harness.runtime.invalidate();
    const read = harness.read().catch((error: unknown) => error);
    await expect(
      harness.startup({
        agentId: "main",
        sessionEntry: { authProfileOverride: "test:session", authProfileOverrideSource: "user" },
      }),
    ).resolves.toBeUndefined();

    await harness.runtime.stop();

    expect(await read).toMatchObject({
      name: "ChatMetadataSnapshotUnavailableError",
      message: "gateway chat metadata runtime is stopped",
    });
    harness.runtime.invalidate();
    harness.runtime.fail(new Error("late owner failure"));
    await expect(harness.refresh()).rejects.toThrow("stopped");
    await expect(harness.read()).rejects.toThrow("stopped");
    await expect(harness.startup()).resolves.toBeUndefined();
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
      const events: string[] = [];
      const { entered, release } = holdPreparation(harness, phase, "agent-0", () =>
        events.push("work settled"),
      );
      await harness.refresh();
      const reading = harness.read({ agentId: "agent-0" }).catch((error: unknown) => {
        events.push("read settled");
        return error;
      });
      try {
        await entered.promise;
        for (const agentId of agentIds.slice(1)) {
          await harness.read({ agentId });
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
        await expect(harness.read({ agentId: "agent-0" })).rejects.toThrow("stopped");
      } finally {
        release.resolve();
        await Promise.allSettled([reading, harness.runtime.stop()]);
      }
    },
  );
});
