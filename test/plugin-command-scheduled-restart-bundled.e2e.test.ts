// Real Gateway processes of one built package prove restart continuity for a core-bundled
// plugin's requester-admitted schedules: the same build re-arms them, while a build change or a
// disabled plugin ends them for good.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../packages/gateway-protocol/src/client-info.js";
import { withDistArtifactOwnership } from "../scripts/lib/dist-artifact-ownership.mts";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { connectRestartClient } from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "scheduled-restart-bundled-proof";
const MODEL = "scheduled-restart-bundled-model";
const SESSION_KEY = "agent:main:scheduled-restart-bundled";
// See plugin-command-scheduled-restart.e2e.test.ts: long enough that a restart usually lands
// between occurrences, short enough to stay well under CI no-output limits.
const EVERY_MS = 20_000;
const MAX_RUNS = 2;
const repoRoot = path.resolve(import.meta.dirname, "..");

type Tick = { pid: number; label: string; module: string };
type ChatEvent = { event?: string; payload?: unknown };
type CronJobView = { id: string; enabled: boolean; state?: Record<string, unknown> };

/** Links a build output tree into a private package, copying across filesystems. */
async function linkTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await linkTree(source, target);
      } else if (entry.isSymbolicLink()) {
        await fs.symlink(await fs.readlink(source), target);
      } else {
        await fs.link(source, target).catch((error: unknown) => {
          const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
          if (code !== "EXDEV" && code !== "EPERM") {
            throw error;
          }
          return fs.copyFile(source, target);
        });
      }
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

/** Replaces, never edits, a file that may share its data with the checkout's build. */
async function replaceFile(file: string, content: string) {
  await fs.rm(file, { force: true });
  await fs.writeFile(file, content);
}

/**
 * A private installed package of the checkout's build, as a package manager lays it out: its own
 * `dist` and `dist-runtime` trees, so a bundled plugin's real path lies in that package's build.
 */
async function stagePackage(root: string, tickFile: string, signal: AbortSignal) {
  const packageRoot = path.join(root, "openclaw");
  await withDistArtifactOwnership(
    repoRoot,
    async () => {
      for (const output of ["dist", "dist-runtime"]) {
        await linkTree(path.join(repoRoot, output), path.join(packageRoot, output));
      }
      await fs.copyFile(
        path.join(repoRoot, "package.json"),
        path.join(packageRoot, "package.json"),
      );
    },
    signal,
  );
  for (const entry of await fs.readdir(repoRoot)) {
    if (
      entry === "node_modules" ||
      entry === "docs" ||
      entry === "skills" ||
      entry === "custodian-skills" ||
      entry === "patches" ||
      entry === "scripts" ||
      entry.endsWith(".mjs")
    ) {
      await fs.symlink(path.join(repoRoot, entry), path.join(packageRoot, entry));
    }
  }
  const buildInfoPath = path.join(packageRoot, "dist", "build-info.json");
  const buildInfo = JSON.parse(await fs.readFile(buildInfoPath, "utf8")) as Record<string, unknown>;
  await replaceFile(buildInfoPath, JSON.stringify(buildInfo));
  // The core-bundled plugin under test ships inside the build, in both bundled trees.
  for (const output of ["dist", "dist-runtime"]) {
    const pluginDir = path.join(packageRoot, output, "extensions", PLUGIN_ID);
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/" + PLUGIN_ID,
        version: "1.0.0",
        private: true,
        type: "module",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: PLUGIN_ID,
        activation: { onStartup: true },
        contracts: {
          commandRuntimeCapabilities: ["subagents", "scheduledTurns"],
          sessionScheduledTurns: ["requester-command"],
        },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await fs.writeFile(path.join(pluginDir, "index.js"), pluginSource(tickFile));
  }
  return {
    packageRoot,
    /**
     * An in-place rebuild at the same paths with the same plugin version. It keeps the build ID,
     * as an explicit UI build ID does, while the build time and commit change.
     */
    rebuild: () =>
      replaceFile(
        buildInfoPath,
        JSON.stringify({ ...buildInfo, commit: "f".repeat(40), builtAt: new Date().toISOString() }),
      ),
    restoreBuild: () => replaceFile(buildInfoPath, JSON.stringify(buildInfo)),
  };
}

function pluginSource(tickFile: string) {
  return `import fs from "node:fs";
export default {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerCommand({
      name: "bundled-schedule",
      description: "Schedule bounded proof ticks",
      requireAuth: true,
      acceptsArgs: true,
      runtimeCapabilities: ["subagents", "scheduledTurns"],
      handler: async (ctx) => {
        const schedules = ctx.runtimeContext?.scheduledTurns;
        if (!schedules) return { text: "UNAVAILABLE" };
        try {
          const accepted = await schedules.schedule({
            requestId: "proof-" + ctx.args,
            command: "bundled-tick",
            args: ctx.args,
            schedule: { kind: "every", everyMs: ${EVERY_MS} },
            deadlineAtMs: Date.now() + 10 * 60_000,
            maxRuns: ${MAX_RUNS},
          });
          return { text: "SCHEDULED " + accepted.jobId + " " + accepted.survivesRestart };
        } catch (error) {
          return { text: "REFUSED " + String(error && error.message) };
        }
      },
    });
    api.registerCommand({
      name: "bundled-tick",
      description: "Record one proof tick",
      requireAuth: true,
      acceptsArgs: true,
      runtimeCapabilities: ["subagents"],
      handler: async (ctx) => {
        fs.appendFileSync(${JSON.stringify(tickFile)}, JSON.stringify({ pid: process.pid, label: ctx.args, module: import.meta.url }) + "\\n");
        return { text: "TICK " + ctx.args };
      },
    });
  },
};
`;
}

it.skipIf(process.platform === "win32")(
  "resumes a core-bundled plugin's schedule on the same build and ends it on another build",
  { timeout: 600_000 },
  async ({ signal }) => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "plugin-scheduled-restart-bundled-")),
    );
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const tickFile = path.join(root, "ticks.jsonl");
    const pkg = await stagePackage(root, tickFile, signal);
    const modelRequests: unknown[] = [];
    const server = await startOpenAiResponsesModelServer({
      modelId: MODEL,
      bindError: "scheduled restart model fixture did not bind",
      onRequest: async (request, response) => {
        // Scheduled command occurrences must never prompt the model.
        modelRequests.push(request.url);
        response.writeHead(500).end();
      },
    });
    onTestFinished(() => server.close());
    const config = createOpenAiResponsesModelConfig({
      baseUrl: server.baseUrl,
      providerId: MODEL,
      modelId: MODEL,
      reasoning: false,
      toolProfile: "minimal",
    });
    // No load path: the plugin is discovered only as a core-bundled plugin of the package.
    config.plugins = {
      allow: [PLUGIN_ID],
      entries: { [PLUGIN_ID]: { enabled: true } },
      slots: { memory: "none" },
    };
    config.tools = {
      profile: "minimal",
      alsoAllow: ["automations", "sessions_spawn", "agents_wait"],
      codeMode: false,
      toolSearch: false,
    };
    config.cron = { enabled: true };
    const instance = await createOpenClawTestInstance({
      name: "plugin-scheduled-restart-bundled",
      cwd: pkg.packageRoot,
      entrypoint: [path.join(pkg.packageRoot, "dist", "index.js")],
      config,
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      },
      startTimeoutMs: 300_000,
    });
    onTestFinished(() => instance.cleanup());

    const deviceIdentity = loadOrCreateDeviceIdentity({
      path: instance.state.path("scheduled-restart-device", "client", "credentials.sqlite"),
    });
    const readTicks = async (): Promise<Tick[]> => {
      const text = await fs.readFile(tickFile, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Tick);
    };
    const ticksFor = async (label: string) =>
      (await readTicks()).filter((tick) => tick.label === label);
    const connect = async () => {
      const events: ChatEvent[] = [];
      const client = await connectRestartClient(instance, {
        deviceIdentity,
        clientName: GATEWAY_CLIENT_IDS.TUI,
        mode: GATEWAY_CLIENT_MODES.UI,
        onEvent: (event) => events.push(event),
      });
      const schedule = async (label: string) => {
        const runId = randomUUID();
        await client.request("chat.send", {
          sessionKey: SESSION_KEY,
          message: "/bundled-schedule " + label,
          deliver: false,
          idempotencyKey: runId,
        });
        let text: string | undefined;
        await vi.waitFor(
          () => {
            const final = events.find((event) => {
              const payload = event.payload as { runId?: string; state?: string } | undefined;
              return (
                event.event === "chat" && payload?.runId === runId && payload.state === "final"
              );
            });
            text = extractFirstTextBlock((final?.payload as { message?: unknown })?.message);
            // The loaded build gives the bundled plugin's schedule restart continuity.
            expect(text, instance.logs()).toMatch(/^SCHEDULED \S+ true$/);
          },
          { timeout: 60_000, interval: 50 },
        );
        return text!.split(" ")[1]!;
      };
      const job = async (id: string) =>
        (
          await client.request<{ jobs: CronJobView[] }>("cron.list", {
            includeDisabled: true,
            limit: 200,
          })
        ).jobs.find((entry) => entry.id === id);
      return { client, schedule, job };
    };
    const restart = async (
      gateway: Awaited<ReturnType<typeof connect>>,
      whileDown?: () => Promise<unknown>,
    ) => {
      await gateway.client.stopAndWait();
      await instance.stopGateway();
      await whileDown?.();
      await instance.startGateway();
      return await connect();
    };
    /** Claims an occurrence now; one with no matching loaded code retires its schedule. */
    const expectRetiredWithoutRunning = async (
      gateway: Awaited<ReturnType<typeof connect>>,
      id: string,
      label: string,
    ) => {
      await gateway.client.request("cron.run", { id, mode: "force" });
      await vi.waitFor(
        async () =>
          expect(await gateway.job(id), instance.logs()).toMatchObject({ enabled: false }),
        { timeout: 60_000, interval: 200 },
      );
      expect(await ticksFor(label)).toEqual([]);
    };

    try {
      await instance.startGateway();
      let gateway = await connect();
      await gateway.client.request("sessions.create", { key: SESSION_KEY, agentId: "main" });

      // Same build: a crash between occurrences re-arms the schedule in the next process.
      const resumed = await gateway.schedule("same-build");
      await vi.waitFor(async () => expect(await ticksFor("same-build")).toHaveLength(1), {
        timeout: 60_000,
        interval: 100,
      });
      const [first] = await ticksFor("same-build");
      // It ran the bundled code shipped inside the private package's build.
      expect(first!.module).toContain(pkg.packageRoot + "/dist");
      expect(first!.module).toContain("/extensions/" + PLUGIN_ID + "/");
      await vi.waitFor(
        async () =>
          expect(await gateway.job(resumed), instance.logs()).toMatchObject({
            state: { lastRunStatus: "ok" },
          }),
        { timeout: 30_000, interval: 100 },
      );
      await gateway.client.stopAndWait();
      await instance.crashGateway();
      await instance.startGateway();
      gateway = await connect();
      await vi.waitFor(
        async () =>
          expect(
            await ticksFor("same-build"),
            JSON.stringify(await gateway.job(resumed)),
          ).toHaveLength(MAX_RUNS),
        { timeout: 240_000, interval: 500 },
      );
      expect((await ticksFor("same-build"))[1]!.pid).not.toBe(first!.pid);
      await vi.waitFor(
        async () => expect(await gateway.job(resumed)).toMatchObject({ enabled: false }),
        { timeout: 30_000, interval: 200 },
      );

      // Another build at the same paths, with the same plugin version and build ID: never re-armed.
      const upgraded = await gateway.schedule("changed-build");
      gateway = await restart(gateway, () => pkg.rebuild());
      await expectRetiredWithoutRunning(gateway, upgraded, "changed-build");

      // A bundled plugin disabled while the Gateway is down never fires again.
      const disabled = await gateway.schedule("plugin-disabled");
      const written = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as typeof config;
      gateway = await restart(gateway, () =>
        instance.state.writeConfig({
          ...written,
          plugins: { ...written.plugins, entries: { [PLUGIN_ID]: { enabled: false } } },
        }),
      );
      await expectRetiredWithoutRunning(gateway, disabled, "plugin-disabled");

      // Restoring the accepting build and re-enabling the plugin revives neither.
      gateway = await restart(gateway, async () => {
        await pkg.restoreBuild();
        await instance.state.writeConfig(written);
      });
      for (const [id, label] of [
        [upgraded, "changed-build"],
        [disabled, "plugin-disabled"],
      ] as const) {
        await expect(
          gateway.client.request("cron.run", { id, mode: "force" }),
        ).resolves.toMatchObject({ ran: false });
        expect(await gateway.job(id)).toMatchObject({ enabled: false });
        expect(await ticksFor(label)).toEqual([]);
      }
      expect(await ticksFor("same-build")).toHaveLength(MAX_RUNS);
      expect(modelRequests).toEqual([]);
      await gateway.client.stopAndWait();
    } catch (error) {
      throw new Error(String(error) + "\n" + instance.logs(), { cause: error });
    }
  },
);
