import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createContinuation,
  type Fixture,
  pluginId,
  withCommandPlugin,
} from "./commands-plugin.scheduled-turns.test-support.js";

// No scheduled occurrence may reach an ordinary session prompt or the embedded model runner.
const guards = vi.hoisted(() => ({ embeddedRuns: 0 }));
// A real restart is a new Gateway process. In-process, only the process identity the Gateway
// thread reports to the scheduler changes; the claim, plugins and state database are real.
const gatewayProcess = vi.hoisted(() => ({ id: undefined as string | undefined, restarts: 0 }));
vi.mock("../../cron/plugin-command-schedule.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../cron/plugin-command-schedule.js")>();
  return {
    ...actual,
    currentPluginCommandHostProcessId: () =>
      gatewayProcess.id ?? actual.currentPluginCommandHostProcessId(),
  };
});
// The build a Gateway process loaded is read once at its startup; a restarted process may have
// loaded another build. Outside the bundled cases the real provenance applies.
const loadedBuild = vi.hoisted(() => ({
  active: false,
  buildId: null as string | null,
  builtAt: "2026-10-22T00:00:00.000Z",
  buildInfoPath: "",
}));
vi.mock("../../version.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../version.js")>();
  return {
    ...actual,
    resolveRuntimeServiceBuildProvenance: () => {
      if (!loadedBuild.active) {
        return actual.resolveRuntimeServiceBuildProvenance();
      }
      return loadedBuild.buildId
        ? {
            buildId: loadedBuild.buildId,
            builtAt: loadedBuild.builtAt,
            buildInfoPath: loadedBuild.buildInfoPath,
          }
        : null;
    },
  };
});
vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  runEmbeddedAgent: async () => {
    guards.embeddedRuns += 1;
    throw new Error("scheduled command test must not run the embedded model runner");
  },
}));

afterEach(() => {
  expect(guards.embeddedRuns, "no embedded model run").toBe(0);
  guards.embeddedRuns = 0;
  gatewayProcess.id = undefined;
  gatewayProcess.restarts = 0;
  loadedBuild.active = false;
  loadedBuild.buildId = null;
  loadedBuild.builtAt = "2026-10-22T00:00:00.000Z";
  loadedBuild.buildInfoPath = "";
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

type RestartChange = NonNullable<Parameters<Fixture["restart"]>[0]>;

/** Restarts as a new Gateway process, applying `change` while it is down. */
async function restartGateway(fixture: Fixture, change?: RestartChange) {
  await fixture.restart(async (cfg, pluginDir) => {
    gatewayProcess.restarts += 1;
    gatewayProcess.id = `restarted-gateway-${gatewayProcess.restarts}`;
    await change?.(cfg, pluginDir);
  });
}

/** A core-bundled fixture plugin served by a Gateway process that loaded `buildId`. */
async function withBundledCommandPlugin(
  run: (fixture: Fixture) => Promise<void>,
  buildId: string | null = "2026.10.22-0123456789ab-2026-10-22T00-00-00.000Z",
) {
  await withCommandPlugin(
    async (fixture) => {
      loadedBuild.active = true;
      loadedBuild.buildId = buildId;
      loadedBuild.buildInfoPath = expectDefined(fixture.bundledBuildInfoPath, "package build");
      expect(fixture.registry.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
        origin: "bundled",
        status: "loaded",
      });
      await run(fixture);
    },
    { bundled: true },
  );
}

/** One occurrence before the restart spends the first of the two allowed attempts. */
async function acceptAndRunOnce(fixture: Fixture) {
  const id = await createContinuation(fixture);
  fixture.handler.mockImplementation(() => ({ text: "before restart" }));
  await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ok: true, ran: true });
  fixture.handler.mockClear();
  return id;
}

async function expectRetired(fixture: Fixture) {
  expect(fixture.handler).not.toHaveBeenCalled();
  expect(fixture.scheduledResults).toEqual([]);
  expect((await fixture.readJobs())[0]).toMatchObject({
    enabled: false,
    state: { pluginCommandRuns: 0 },
  });
}

describe("requester-admitted scheduled commands across a Gateway restart", () => {
  it.each([false, true])(
    "re-arms the same code and exhausts its budget (bundled=%s)",
    async (bundled) => {
      const withPlugin = bundled ? withBundledCommandPlugin : withCommandPlugin;
      await withPlugin(async (fixture) => {
        const id = await acceptAndRunOnce(fixture);
        if (bundled) {
          expect((await fixture.readJobs())[0]?.state.pluginCommandBinding?.sourceDigest).toMatch(
            /^bundled-build:/u,
          );
        }
        const original = fixture.pluginIncarnation();
        await restartGateway(fixture);
        expect(fixture.pluginIncarnation()).toBeDefined();
        expect(fixture.pluginIncarnation()).not.toBe(original);
        fixture.handler.mockImplementation((ctx) => ({ text: "after restart: " + ctx.args }));
        await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ok: true, ran: true });
        expect(fixture.handler).toHaveBeenCalledTimes(1);
        expect(fixture.scheduledResults).toMatchObject([
          { status: "ok", outputText: "before restart" },
          { status: "ok", outputText: "after restart: undefined" },
        ]);
        expect(JSON.stringify(await fixture.assistantOutputs())).toContain("after restart");
        // The final allowed attempt retires it under the instance the claim re-armed it onto.
        const [completed] = await fixture.readJobs();
        expect(completed).toMatchObject({
          enabled: false,
          state: {
            pluginCommandRuns: 2,
            pluginCommandBinding: {
              hostProcessId: "restarted-gateway-1",
              pluginIncarnation: fixture.pluginIncarnation(),
            },
          },
        });
        // A completed schedule stays completed across another restart.
        await restartGateway(fixture);
        await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ran: false });
        expect(fixture.handler).toHaveBeenCalledTimes(1);
        expect(fixture.scheduledResults).toHaveLength(2);
      });
    },
  );

  it("never resurrects a schedule cancelled before the restart", async () => {
    await withCommandPlugin(async (fixture) => {
      const id = await createContinuation(fixture);
      await fixture.cron.update(id, { enabled: false });
      await restartGateway(fixture);
      await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ran: false });
      expect(fixture.handler).toHaveBeenCalledTimes(1);
      expect(fixture.scheduledResults).toEqual([]);
      expect(await fixture.readJobs()).toMatchObject([
        { enabled: false, state: { pluginCommandRuns: 0 } },
      ]);
    });
  });

  it.each([
    ["demoted", (fixture: Fixture) => fixture.demoteOwner()],
    ["removed", (fixture: Fixture) => fixture.removeOwner()],
  ])("rechecks the requester after the restart and refuses a %s one", async (_label, revoke) => {
    await withCommandPlugin(async (fixture) => {
      const id = await acceptAndRunOnce(fixture);
      await restartGateway(fixture);
      revoke(fixture);
      const inputs = await fixture.userInputs();
      await fixture.cron.run(id, "force");
      // The claim re-armed it; the occurrence's own requester restoration refused it.
      expect(fixture.scheduledResults[1]).toMatchObject({
        status: "error",
        error: expect.stringMatching(/operator authority/i),
        executionStarted: false,
      });
      expect((await fixture.readJobs())[0]?.state.pluginCommandBinding?.hostProcessId).toBe(
        "restarted-gateway-1",
      );
      // Refused before the command or its input is accepted.
      expect(fixture.handler).not.toHaveBeenCalled();
      expect(await fixture.userInputs()).toEqual(inputs);
    });
  });

  it.each([
    [
      "disabled",
      false,
      (cfg) => {
        cfg.plugins = { ...cfg.plugins, entries: { [pluginId]: { enabled: false } } };
      },
    ],
    [
      // The same plugin ID, location and version, but different code.
      "changed",
      true,
      async (_cfg, pluginDir) => {
        await fs.appendFile(path.join(pluginDir, "index.cjs"), "\n// changed after acceptance\n");
      },
    ],
    [
      "uninstalled",
      false,
      async (cfg, pluginDir) => {
        cfg.plugins = { ...cfg.plugins, load: { paths: [] } };
        await fs.rm(pluginDir, { recursive: true, force: true });
      },
    ],
  ] satisfies Array<[string, boolean, RestartChange]>)(
    "never fires for a %s plugin after the restart",
    async (_label, loaded, change) => {
      await withCommandPlugin(async (fixture) => {
        const id = await createContinuation(fixture);
        fixture.handler.mockClear();
        await restartGateway(fixture, change);
        // A changed plugin loads, but a new instance whose code no longer matches the schedule.
        expect(fixture.pluginIncarnation() !== undefined).toBe(loaded);
        await fixture.cron.run(id, "force");
        await expectRetired(fixture);
      });
    },
  );

  describe("core-bundled plugins", () => {
    it.each([
      [
        "upgraded or downgraded to another build",
        () => {
          loadedBuild.buildId = "2026.10.23-fedcba987654-2026-10-23T00-00-00.000Z";
          loadedBuild.builtAt = "2026-10-23T00:00:00.000Z";
        },
      ],
      [
        // An explicit UI build ID repeats across builds; the build time does not.
        "rebuilt under the same explicit build ID",
        () => {
          loadedBuild.builtAt = "2026-10-22T00:05:00.000Z";
        },
      ],
      [
        "disabled",
        (cfg: Parameters<RestartChange>[0]) => {
          cfg.plugins = { ...cfg.plugins, entries: { [pluginId]: { enabled: false } } };
        },
      ],
    ] satisfies Array<[string, RestartChange]>)(
      "never fires once the plugin is %s across the restart",
      async (_label, change) => {
        await withBundledCommandPlugin(async (fixture) => {
          const acceptedBuild = { ...loadedBuild };
          const id = await createContinuation(fixture);
          fixture.handler.mockClear();
          await restartGateway(fixture, change);
          await fixture.cron.run(id, "force");
          await expectRetired(fixture);
          // Returning to the accepting build and plugin later does not revive it.
          await restartGateway(fixture, (cfg) => {
            loadedBuild.buildId = acceptedBuild.buildId;
            loadedBuild.builtAt = acceptedBuild.builtAt;
            cfg.plugins = { ...cfg.plugins, entries: { [pluginId]: { enabled: true } } };
          });
          expect(fixture.pluginIncarnation()).toBeDefined();
          await expect(fixture.cron.run(id, "force")).resolves.toMatchObject({ ran: false });
          expect(fixture.handler).not.toHaveBeenCalled();
        });
      },
    );

    it("keeps a schedule process-lifetime when the process loaded no build record", async () => {
      // A source run has no build ID, so bundled code there has no sound identity.
      await withBundledCommandPlugin(async (fixture) => {
        const id = await createContinuation(fixture);
        fixture.handler.mockClear();
        expect((await fixture.readJobs())[0]?.state.pluginCommandBinding).toBeUndefined();
        await restartGateway(fixture);
        await fixture.cron.run(id, "force");
        expect(fixture.handler).not.toHaveBeenCalled();
        expect(fixture.scheduledResults).toEqual([]);
        expect((await fixture.readJobs())[0]).toMatchObject({ enabled: false });
      }, null);
    });
  });
});
