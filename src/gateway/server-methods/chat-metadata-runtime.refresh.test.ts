import { createServer, get } from "node:http";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { setPreparedModelRuntimeStartupStatus } from "../../agents/prepared-model-runtime.startup-status.js";
import { handleGatewayProbeRequest } from "../server-http-probes.js";
import {
  createChatMetadataHarness,
  createChatMetadataOwner,
} from "./chat-metadata-runtime.test-support.js";

describe("gateway chat metadata runtime", () => {
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
      const config = { agents: { list: [{ id: "main", default: true }, { id: "second" }] } };
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

  test.each(["skills", "plugins"] as const)(
    "rechecks %s publication before returning a suspended agent projection",
    async (changed) => {
      const harness = createChatMetadataHarness({
        agents: { list: [{ id: "main", default: true }, { id: "second" }] },
      });
      const mainEntered = createDeferred();
      const releaseMain = createDeferred();
      const releaseSecond = createDeferred();
      harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
        mainEntered.resolve();
        await releaseMain.promise;
        return { models: facts.modelCatalog.entries, modelCatalog: facts.modelCatalog.entries };
      });
      harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
        await releaseSecond.promise;
        return { models: facts.modelCatalog.entries, modelCatalog: facts.modelCatalog.entries };
      });
      const refresh = harness.runtime.refresh();
      let replacement: Promise<void> | undefined;
      let settled = false;
      const reading = harness.runtime.read({ agentId: "main" }).then((result) => {
        settled = true;
        return result;
      });
      try {
        await mainEntered.promise;
        if (changed === "skills") {
          harness.setSkillsVersion(2);
        } else {
          harness.setPluginRegistryVersion(2);
        }
        replacement = harness.runtime.refresh();
        releaseMain.resolve();
        await nextEventLoopTurn();
        expect(settled).toBe(false);
        releaseSecond.resolve();
        await Promise.all([refresh, replacement]);
        await expect(reading).resolves.toMatchObject({
          commands: [{ name: changed === "skills" ? "command-2-1" : "command-1-2" }],
        });
      } finally {
        releaseMain.resolve();
        releaseSecond.resolve();
        await Promise.allSettled([refresh, replacement, reading, harness.runtime.stop()]);
      }
    },
  );

  test("ignores catalog progress and publishes failure transitions once each", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    const catalog = harness.getPreparedOwner()!.modelCatalog;
    try {
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledOnce();

      catalog.pendingProviders = ["test"];
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledOnce();
      catalog.pendingProviders = ["test"];
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledOnce();

      catalog.pendingProviders = undefined;
      catalog.refreshFailed = true;
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(2);

      catalog.refreshFailed = undefined;
      await harness.runtime.refresh();
      await harness.runtime.refresh();
      expect(onChanged).toHaveBeenCalledTimes(3);
    } finally {
      await harness.runtime.stop();
    }
  });

  test.each([
    { settlement: "resolve", explicitInvalidation: true },
    { settlement: "reject", explicitInvalidation: true },
    { settlement: "resolve", explicitInvalidation: false },
    { settlement: "reject", explicitInvalidation: false },
  ] as const)(
    "retries a session projection after late $settlement (explicit invalidation: $explicitInvalidation)",
    async ({ settlement, explicitInvalidation }) => {
      const harness = createChatMetadataHarness();
      await harness.runtime.refresh();
      await harness.runtime.read({ agentId: "main" });
      const releaseProjection = createDeferred();
      harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
        await releaseProjection.promise;
        if (settlement === "reject") {
          throw new Error("obsolete projection failed");
        }
        return {
          modelCatalog: facts.owner.modelCatalog.entries,
          models: facts.owner.modelCatalog.entries,
        };
      });

      let settled = false;
      const read = harness.runtime
        .read({
          agentId: "main",
          sessionEntry: {
            authProfileOverride: "test:session",
            authProfileOverrideSource: "user",
          },
        })
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));

      const nextConfig = {
        agents: { list: [{ id: "main", default: true }] },
        tools: { swarm: { enabled: true } },
      };
      harness.setConfig(nextConfig);
      harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
      const releaseCommands = createDeferred();
      harness.buildCommands.mockImplementationOnce(async () => {
        await releaseCommands.promise;
        return { commands: [] };
      });
      if (explicitInvalidation) {
        harness.runtime.invalidate();
      }
      const refresh = harness.runtime.refresh();
      void read.catch(() => {});
      try {
        releaseProjection.resolve();
        await nextEventLoopTurn();
        expect(settled).toBe(false);
        releaseCommands.resolve();
        await refresh;
        await expect(read).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "replacement" })],
          swarmEnabled: true,
        });
      } finally {
        releaseCommands.resolve();
        await Promise.allSettled([read, refresh]);
        await harness.runtime.stop();
      }
    },
  );

  test.each(["resolve", "reject"] as const)(
    "discards a late projection's %s after cooldown state changes",
    async (settlement) => {
      const harness = createChatMetadataHarness(undefined, { refreshOnRead: false });
      const blocked: AuthProfileStore = {
        version: 1,
        profiles: { "test:session": { type: "api_key", provider: "test", key: "not-real" } },
        usageStats: { "test:session": { cooldownUntil: Date.now() + 60_000 } },
      };
      harness.setAuthStore(blocked);
      const project = async ({ facts }: Parameters<typeof harness.buildProjection>[0]) => ({
        modelCatalog: facts.modelCatalog.entries,
        models: facts.modelCatalog.entries.map((entry) => ({
          ...entry,
          available: !facts.authStore.usageStats?.["test:session"]?.cooldownUntil,
        })),
      });
      harness.buildProjection.mockImplementation(project);
      await harness.runtime.refresh();
      const entered = createDeferred();
      const release = createDeferred();
      harness.buildProjection.mockImplementationOnce(async (params) => {
        entered.resolve();
        await release.promise;
        if (settlement === "reject") {
          throw new Error("obsolete usage projection failed");
        }
        return project(params);
      });
      const reading = harness.runtime.read({
        agentId: "main",
        sessionEntry: { authProfileOverride: "test:session" },
      });
      try {
        await entered.promise;
        harness.setAuthStore({ ...blocked, usageStats: {} });
        harness.setAuthStoreRevision(2);
        release.resolve();
        await expect(reading).resolves.toMatchObject({
          models: [expect.objectContaining({ available: true })],
        });
      } finally {
        release.resolve();
        await Promise.allSettled([reading, harness.runtime.stop()]);
      }
    },
  );
});
