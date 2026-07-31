import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readRetainedLegacyDefaultCronOwnerForStore } from "../cron/legacy-default-agent-owner-handoff.js";
import { registerLiveCronService } from "../cron/live-service-registry.js";
import { loadCronJobsStoreWithConfigJobsReadOnly, saveCronJobsStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { createConfigIO, resetConfigRuntimeState } from "./io.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type CronConfigWithStore = NonNullable<OpenClawConfig["cron"]> & { store?: string };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetConfigRuntimeState();
});

function cronJob(id: string, agentId?: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: id },
    state: {},
    ...(agentId ? { agentId } : {}),
  };
}

async function createStoreSwitchFixture(
  destinationJobs: CronJob[],
  agents: OpenClawConfig["agents"] | null = {
    ownership: "explicit",
    entries: { ops: {}, research: {} },
  },
  options: {
    declarePaths?: boolean;
    fsModule?: typeof fsNode;
    nextAgents?: OpenClawConfig["agents"];
    nextSessionStore?: string;
    sessionStore?: string;
    switchStore?: boolean;
  } = {},
) {
  const root = tempDirs.make("openclaw-cron-store-switch-");
  const configPath = path.join(root, "openclaw.json");
  const sourceStorePath = path.join(root, "cron", "source.json");
  const destinationStorePath = path.join(root, "cron", "destination.json");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_TEST_FAST: "1",
  } as NodeJS.ProcessEnv;
  const config = {
    ...(agents !== null ? { agents } : {}),
    ...(options.sessionStore ? { session: { store: options.sessionStore } } : {}),
    cron: { store: sourceStorePath } as CronConfigWithStore,
  } satisfies OpenClawConfig;
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, "utf8");
  const targetStorePath = options.switchStore === false ? sourceStorePath : destinationStorePath;
  await saveCronJobsStore(targetStorePath, { version: 1, jobs: destinationJobs }, { env });
  const io = createConfigIO({
    configPath,
    env,
    homedir: () => root,
    observe: false,
    preservedLegacyRootKeys: ["cron"],
    logger: { warn: () => {}, error: () => {} },
    ...(options.fsModule ? { fs: options.fsModule } : {}),
  });
  const snapshot = await io.readConfigFileSnapshot();
  const nextConfig = {
    ...snapshot.config,
    ...(options.nextAgents ? { agents: options.nextAgents } : {}),
    ...(options.nextSessionStore ? { session: { store: options.nextSessionStore } } : {}),
    cron: { ...(snapshot.config.cron as object), store: targetStorePath },
  } as OpenClawConfig;
  const allowedAgentRosterRemovals = options.nextAgents
    ? Object.keys(agents?.entries ?? {}).filter(
        (agentId) => !Object.hasOwn(options.nextAgents?.entries ?? {}, agentId),
      )
    : [];
  const write = (preCommitRuntimePreflight?: () => Promise<void>) =>
    io.writeConfigFile(nextConfig, {
      baseSnapshot: snapshot,
      ...(options.declarePaths === false
        ? {}
        : { explicitSetPaths: [options.nextAgents ? ["agents"] : ["cron"]] }),
      explicitSetValueSource: nextConfig,
      ...(allowedAgentRosterRemovals.length > 0 ? { allowedAgentRosterRemovals } : {}),
      preservedLegacyRootKeys: ["cron"],
      ...(preCommitRuntimePreflight ? { preCommitRuntimePreflight } : {}),
    });
  return { configPath, destinationStorePath: targetStorePath, env, io, write };
}

describe("cron store switch ownership guard", () => {
  it("refuses an explicit-roster switch to ownerless destination jobs", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("ownerless")]);

    await expect(fixture.write()).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });

  it("refuses an undeclared full-config switch to explicit ownership and ownerless jobs", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {}, research: {} } },
      {
        declarePaths: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );

    await expect(fixture.write()).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });

  it("stamps ownership for an undeclared full-roster rewrite of a migrated fleet", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("owned", "research")],
      { entries: { ops: { default: true }, research: {} } },
      {
        declarePaths: false,
        sessionStore: "/tmp/openclaw-fixed-sessions.json",
        switchStore: false,
        nextAgents: { entries: { research: {}, ops: {} } },
      },
    );

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.ownership).toBe("explicit");
    expect(persisted.agents?.entries?.ops?.workspace).toBe(
      path.join(fixture.env.HOME!, ".openclaw", "workspace"),
    );
    expect(persisted.agents?.defaults).toMatchObject({
      heartbeat: { agentId: "ops" },
      systemAgent: { agentId: "ops" },
      authInheritance: { agentId: "ops" },
      sessionStore: { agentId: "ops" },
    });
  });

  it("refuses a same-store sole replacement with ownerless jobs", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: { default: true } } },
      {
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { research: {}, writer: {} },
        },
      },
    );

    await expect(fixture.write()).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });

  it("allows an explicit-roster switch when destination jobs have owners", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("owned", "ops")]);

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect((persisted.cron as CronConfigWithStore | undefined)?.store).toBe(
      fixture.destinationStorePath,
    );
  });

  it("refuses a destination job owned by an agent absent from the incoming roster", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("departed-owner", "legacy-agent")]);

    await expect(fixture.write()).rejects.toThrow("agents absent from the incoming roster");
  });

  it("allows an explicit-roster switch when a session key owns the destination job", async () => {
    const fixture = await createStoreSwitchFixture([
      { ...cronJob("session-owned"), sessionKey: "agent:ops:main" },
    ]);

    await expect(fixture.write()).resolves.toBeDefined();
  });

  it("refuses conflicting destination agentId and session-key owners", async () => {
    const fixture = await createStoreSwitchFixture([
      { ...cronJob("mismatch", "ops"), sessionKey: "agent:research:main" },
    ]);

    await expect(fixture.write()).rejects.toThrow(
      "cron job agentId ops does not match sessionKey owner research",
    );
  });

  it("refuses a blank destination agentId even with a scoped session key", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("valid", "ops")]);
    await fs.mkdir(path.dirname(fixture.destinationStorePath), { recursive: true });
    await fs.writeFile(
      fixture.destinationStorePath,
      JSON.stringify([
        {
          ...cronJob("blank"),
          agentId: "",
          sessionKey: "agent:ops:main",
        },
      ]),
      "utf8",
    );

    await expect(fixture.write()).rejects.toThrow(
      "cron job agentId must not be blank or malformed when supplied",
    );
  });

  it("refuses a malformed destination agentId before normalization", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("valid", "ops")]);
    await fs.mkdir(path.dirname(fixture.destinationStorePath), { recursive: true });
    await fs.writeFile(
      fixture.destinationStorePath,
      JSON.stringify([{ ...cronJob("malformed"), agentId: "!!!" }]),
      "utf8",
    );

    await expect(fixture.write()).rejects.toThrow(
      "cron job agentId must not be blank or malformed when supplied",
    );
  });

  it("allows an implicit-main switch to ownerless destination jobs", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("implicit-main")], null);

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect((persisted.cron as CronConfigWithStore | undefined)?.store).toBe(
      fixture.destinationStorePath,
    );
  });

  it("ignores an ownerless legacy row shadowed by an owned current row", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("shadowed", "ops")]);
    await fs.mkdir(path.dirname(fixture.destinationStorePath), { recursive: true });
    await fs.writeFile(fixture.destinationStorePath, JSON.stringify([cronJob("shadowed")]), "utf8");

    await expect(fixture.write()).resolves.toBeDefined();
  });

  it("rechecks destination ownership at the config commit boundary", async () => {
    const fixture = await createStoreSwitchFixture([cronJob("initially-owned", "ops")]);

    await expect(
      fixture.write(async () => {
        await saveCronJobsStore(
          fixture.destinationStorePath,
          { version: 1, jobs: [cronJob("late-ownerless")] },
          { env: fixture.env },
        );
      }),
    ).rejects.toThrow("contains 1 ownerless legacy cron job(s)");
  });

  it("leaves cron rows and receipts unchanged when the base snapshot loses the commit race", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {} } },
      {
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );
    const before = await loadCronJobsStoreWithConfigJobsReadOnly(
      fixture.destinationStorePath,
      fixture.env,
    );
    const receiptBefore = readRetainedLegacyDefaultCronOwnerForStore(
      fixture.destinationStorePath,
      fixture.env,
    );

    await expect(
      fixture.write(async () => {
        await fs.writeFile(
          fixture.configPath,
          `${JSON.stringify({
            agents: {
              ownership: "explicit",
              entries: { research: {}, writer: {} },
            },
            cron: { store: fixture.destinationStorePath },
          })}\n`,
          "utf8",
        );
      }),
    ).rejects.toThrow("config changed since last load");

    await expect(
      loadCronJobsStoreWithConfigJobsReadOnly(fixture.destinationStorePath, fixture.env),
    ).resolves.toEqual(before);
    expect(
      readRetainedLegacyDefaultCronOwnerForStore(fixture.destinationStorePath, fixture.env),
    ).toBe(receiptBefore);
  });

  it("keeps a concurrent config writer behind the cron handoff commit fence", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {} } },
      {
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );
    let markHandoffStarted = () => {};
    const handoffStarted = new Promise<void>((resolve) => {
      markHandoffStarted = resolve;
    });
    let releaseHandoff = () => {};
    const handoffMayFinish = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const registration = registerLiveCronService(fixture.destinationStorePath, {
      beginLegacyDefaultAgentOwnerHandoff: async (_agentId, options) => {
        markHandoffStarted();
        await handoffMayFinish;
        await options?.beforeMigration?.();
        return { migration: { changes: [], warnings: [] }, release: () => {} };
      },
      refreshLegacyDefaultAgentOwnerHandoff: async () => {},
    });

    try {
      const firstWrite = fixture.write();
      await handoffStarted;
      const concurrentSnapshot = await fixture.io.readConfigFileSnapshot();
      const concurrentWrite = fixture.io.writeConfigFile(
        { ...concurrentSnapshot.config, gateway: { mode: "local", port: 19_001 } },
        { baseSnapshot: concurrentSnapshot, preservedLegacyRootKeys: ["cron"] },
      );
      let concurrentOutcome: unknown;
      void concurrentWrite.then(
        (value) => {
          concurrentOutcome = { status: "resolved", value };
        },
        (error: unknown) => {
          concurrentOutcome = { status: "rejected", error };
        },
      );
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
      expect(concurrentOutcome).toBeUndefined();

      releaseHandoff();
      await expect(firstWrite).resolves.toBeDefined();
      await expect(concurrentWrite).rejects.toThrow("config changed since last load");
      const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
      expect(Object.keys(persisted.agents?.entries ?? {}).toSorted()).toEqual(["ops", "research"]);
      expect(persisted.agents?.ownership).toBe("explicit");
      expect(persisted.gateway).toBeUndefined();
    } finally {
      releaseHandoff();
      registration.unregister();
    }
  });

  it("rolls back prepared cron ownership when an external edit wins during handoff", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {} } },
      {
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );
    const receiptBefore = readRetainedLegacyDefaultCronOwnerForStore(
      fixture.destinationStorePath,
      fixture.env,
    );
    let markHandoffStarted = () => {};
    const handoffStarted = new Promise<void>((resolve) => {
      markHandoffStarted = resolve;
    });
    let releaseHandoff = () => {};
    const handoffMayFinish = new Promise<void>((resolve) => {
      releaseHandoff = resolve;
    });
    const registration = registerLiveCronService(fixture.destinationStorePath, {
      beginLegacyDefaultAgentOwnerHandoff: async (_agentId, options) => {
        markHandoffStarted();
        await handoffMayFinish;
        await options?.beforeMigration?.();
        return { migration: { changes: [], warnings: [] }, release: () => {} };
      },
      refreshLegacyDefaultAgentOwnerHandoff: async () => {},
    });
    const winningConfig = `${JSON.stringify({
      agents: {
        ownership: "explicit",
        entries: { research: {}, writer: {} },
      },
      cron: { store: fixture.destinationStorePath },
    })}\n`;

    try {
      const write = fixture.write();
      await handoffStarted;
      await fs.writeFile(fixture.configPath, winningConfig, "utf8");
      releaseHandoff();

      await expect(write).rejects.toThrow("config changed since last load");
      await expect(fs.readFile(fixture.configPath, "utf8")).resolves.toBe(winningConfig);
      await expect(
        loadCronJobsStoreWithConfigJobsReadOnly(fixture.destinationStorePath, fixture.env),
      ).resolves.toMatchObject({
        store: { jobs: [expect.not.objectContaining({ agentId: "ops" })] },
      });
      expect(
        readRetainedLegacyDefaultCronOwnerForStore(fixture.destinationStorePath, fixture.env),
      ).toBe(receiptBefore);
    } finally {
      releaseHandoff();
      registration.unregister();
    }
  });

  it("rolls back prepared cron ownership when the atomic rename fails", async () => {
    const injectedFs = {
      ...fsNode,
      promises: {
        ...fsNode.promises,
        rename: async (from, to) => {
          if (path.basename(String(to)) === "openclaw.json") {
            throw new Error("synthetic config rename failure");
          }
          return await fsNode.promises.rename(from, to);
        },
      },
    } as typeof fsNode;
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {} } },
      {
        fsModule: injectedFs,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );
    const configBefore = await fs.readFile(fixture.configPath, "utf8");

    await expect(fixture.write()).rejects.toThrow("synthetic config rename failure");
    await expect(fs.readFile(fixture.configPath, "utf8")).resolves.toBe(configBefore);
    const jobs = (
      await loadCronJobsStoreWithConfigJobsReadOnly(fixture.destinationStorePath, fixture.env)
    ).store.jobs;
    expect(jobs[0]?.agentId).toBeUndefined();
    expect(
      readRetainedLegacyDefaultCronOwnerForStore(fixture.destinationStorePath, fixture.env),
    ).toBeUndefined();
  });

  it("rolls back committed cron ownership when sealed-service refresh fails", async () => {
    const fixture = await createStoreSwitchFixture(
      [cronJob("ownerless")],
      { entries: { ops: {} } },
      {
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );
    const registration = registerLiveCronService(fixture.destinationStorePath, {
      beginLegacyDefaultAgentOwnerHandoff: async (_agentId, options) => {
        await options?.beforeMigration?.();
        return { migration: { changes: [], warnings: [] }, release: () => {} };
      },
      refreshLegacyDefaultAgentOwnerHandoff: async () => {
        throw new Error("synthetic sealed refresh failure");
      },
    });

    try {
      await expect(fixture.write()).rejects.toThrow("rollback did not complete");
      const jobs = (
        await loadCronJobsStoreWithConfigJobsReadOnly(fixture.destinationStorePath, fixture.env)
      ).store.jobs;
      expect(jobs[0]?.agentId).toBeUndefined();
      expect(
        readRetainedLegacyDefaultCronOwnerForStore(fixture.destinationStorePath, fixture.env),
      ).toBeUndefined();
    } finally {
      registration.unregister();
    }
  });

  it("removes legacy-import rows and receipts when the config rename fails", async () => {
    const injectedFs = {
      ...fsNode,
      promises: {
        ...fsNode.promises,
        rename: async (from, to) => {
          if (path.basename(String(to)) === "openclaw.json") {
            throw new Error("synthetic legacy-import rename failure");
          }
          return await fsNode.promises.rename(from, to);
        },
      },
    } as typeof fsNode;
    const fixture = await createStoreSwitchFixture(
      [],
      { entries: { ops: {} } },
      {
        fsModule: injectedFs,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
    );
    await fs.mkdir(path.dirname(fixture.destinationStorePath), { recursive: true });
    await fs.writeFile(
      fixture.destinationStorePath,
      JSON.stringify([cronJob("legacy-ownerless"), cronJob("legacy-owned", "research")]),
      "utf8",
    );

    await expect(fixture.write()).rejects.toThrow("synthetic legacy-import rename failure");
    await expect(
      loadCronJobsStoreWithConfigJobsReadOnly(fixture.destinationStorePath, fixture.env),
    ).resolves.toMatchObject({ store: { jobs: [] } });
    const { loadLegacyCronRepairState } = await import("../commands/doctor/cron/legacy-repair.js");
    const repairState = await loadLegacyCronRepairState({
      cfg: {},
      storePath: fixture.destinationStorePath,
      env: fixture.env,
      readOnly: true,
    });
    expect(repairState?.legacyMigrationAlreadyImported).toBe(false);
  });

  it("retains a removed sole agent as the fixed-session-store compatibility owner", async () => {
    const sessionStore = path.join(tempDirs.make("openclaw-fixed-session-owner-"), "sessions.json");
    const fixture = await createStoreSwitchFixture(
      [cronJob("owned", "research")],
      { entries: { ops: {} } },
      {
        sessionStore,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { research: {}, writer: {} },
        },
      },
    );

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe("ops");
  });

  it("retains a removed sole agent across a same-store sole replacement", async () => {
    const sessionStore = path.join(tempDirs.make("openclaw-fixed-session-swap-"), "sessions.json");
    const fixture = await createStoreSwitchFixture(
      [cronJob("owned", "research")],
      { entries: { ops: {} } },
      {
        sessionStore,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { research: {} },
        },
      },
    );

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBe("ops");
  });

  it("does not replace an explicitly empty fixed-store compatibility owner", async () => {
    const sessionStore = path.join(
      tempDirs.make("openclaw-invalid-session-owner-"),
      "sessions.json",
    );
    const fixture = await createStoreSwitchFixture(
      [cronJob("owned", "research")],
      { entries: { ops: {} } },
      {
        sessionStore,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "" } },
          entries: { research: {} },
        },
      },
    );

    await expect(fixture.write()).rejects.toThrow(/sessionStore|Agent id/u);
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.agents?.entries).toEqual({ ops: {} });
  });

  it("does not stamp a removed sole owner onto a different fixed session store", async () => {
    const root = tempDirs.make("openclaw-foreign-session-store-");
    const sourceSessionStore = path.join(root, "source-sessions.json");
    const destinationSessionStore = path.join(root, "destination-sessions.json");
    const fixture = await createStoreSwitchFixture(
      [cronJob("owned", "research")],
      { entries: { ops: {} } },
      {
        sessionStore: sourceSessionStore,
        nextSessionStore: destinationSessionStore,
        declarePaths: false,
        switchStore: false,
        nextAgents: {
          ownership: "explicit",
          entries: { research: {}, writer: {} },
        },
      },
    );

    await expect(fixture.write()).resolves.toBeDefined();
    const persisted = JSON.parse(await fs.readFile(fixture.configPath, "utf8")) as OpenClawConfig;
    expect(persisted.session?.store).toBe(destinationSessionStore);
    expect(persisted.agents?.defaults?.sessionStore?.agentId).toBeUndefined();
  });
});
