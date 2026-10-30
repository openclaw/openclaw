// Real Gateway processes on one isolated state directory prove restart continuity for
// requester-admitted scheduled command turns, without double-firing or reviving ended schedules.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../packages/gateway-protocol/src/client-info.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { connectRestartClient } from "./gateway-restart.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const PLUGIN_ID = "scheduled-restart-proof";
const MODEL = "scheduled-restart-model";
const SESSION_KEY = "agent:main:scheduled-restart";
// Long enough that a restart between occurrences usually finishes before the next slot, so no
// startup deferral applies; short enough to keep the run well under CI no-output limits.
const EVERY_MS = 20_000;
const MAX_RUNS = 2;

type Tick = { pid: number; label: string };
type ChatEvent = { event?: string; payload?: unknown };
type CronJobView = { id: string; enabled: boolean; name: string };

function pluginSource(tickFile: string) {
  return `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    if (!api.runtime.capabilities?.includes("command-scheduled-turns-restart-v1")) {
      throw new Error("restart continuity capability missing");
    }
    api.registerCommand({
      name: "proof-schedule",
      description: "Schedule bounded proof ticks",
      requireAuth: true,
      acceptsArgs: true,
      runtimeCapabilities: ["subagents", "scheduledTurns"],
      handler: async (ctx) => {
        const schedules = ctx.runtimeContext?.scheduledTurns;
        if (!schedules) return { text: "UNAVAILABLE " + JSON.stringify(Object.keys(ctx.runtimeContext ?? {})) };
        try {
          const accepted = await schedules.schedule({
            requestId: "proof-" + ctx.args,
            command: "proof-tick",
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
      name: "proof-tick",
      description: "Record one proof tick",
      requireAuth: true,
      acceptsArgs: true,
      runtimeCapabilities: ["subagents"],
      handler: async (ctx) => {
        fs.appendFileSync(${JSON.stringify(tickFile)}, JSON.stringify({ pid: process.pid, label: ctx.args }) + "\\n");
        return { text: "TICK " + ctx.args };
      },
    });
  },
};
`;
}

it.skipIf(process.platform === "win32")(
  "resumes an accepted schedule after a Gateway crash and never revives an ended one",
  { timeout: 600_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-scheduled-restart-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const tickFile = path.join(root, "ticks.jsonl");
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
    // A configured plugin path loads captured source, whose digest is the code identity a
    // restarted Gateway must match before it re-arms a schedule.
    const pluginDir = path.join(root, "plugins", PLUGIN_ID);
    await fs.mkdir(pluginDir, { recursive: true });
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
    const config = createOpenAiResponsesModelConfig({
      baseUrl: server.baseUrl,
      providerId: MODEL,
      modelId: MODEL,
      reasoning: false,
      toolProfile: "minimal",
    });
    config.plugins = {
      allow: [PLUGIN_ID],
      load: { paths: [pluginDir] },
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
      name: "plugin-scheduled-restart",
      config,
      env: {
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
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
      // A paired operator device, as a real chat client: the requester whose authority each
      // scheduled occurrence restores.
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
          message: "/proof-schedule " + label,
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
            // Captured plugin source gives this schedule restart continuity.
            expect(text, instance.logs()).toMatch(/^SCHEDULED \S+ true$/);
          },
          { timeout: 60_000, interval: 50 },
        );
        return text!.split(" ")[1]!;
      };
      const jobs = async () =>
        (
          await client.request<{ jobs: CronJobView[] }>("cron.list", {
            includeDisabled: true,
            limit: 200,
          })
        ).jobs;
      return { client, schedule, jobs };
    };

    try {
      await instance.startGateway();
      let gateway = await connect();
      // The requester's parent conversation; every scheduled occurrence is recorded there.
      await gateway.client.request("sessions.create", { key: SESSION_KEY, agentId: "main" });
      const resumed = await gateway.schedule("resumed");
      const cancelled = await gateway.schedule("cancelled");
      await gateway.client.request("cron.update", { id: cancelled, patch: { enabled: false } });
      await vi.waitFor(async () => expect(await ticksFor("resumed")).toHaveLength(1), {
        timeout: 60_000,
        interval: 100,
      });
      const firstPid = (await ticksFor("resumed"))[0]!.pid;
      // Crash between occurrences, with the first attempt settled.
      await vi.waitFor(
        async () => {
          const job = (await gateway.jobs()).find((entry) => entry.id === resumed);
          expect(job, instance.logs()).toMatchObject({ state: { lastRunStatus: "ok" } });
        },
        { timeout: 30_000, interval: 100 },
      );
      await gateway.client.stopAndWait();
      await instance.crashGateway();
      await instance.startGateway();
      gateway = await connect();

      // The remaining budget runs in the new process: never more than maxRuns in total. A slow
      // restart that misses the slot defers it by the scheduler's startup delay instead.
      await vi.waitFor(
        async () => {
          const job = (await gateway.jobs()).find((entry) => entry.id === resumed);
          expect(await ticksFor("resumed"), JSON.stringify(job)).toHaveLength(MAX_RUNS);
        },
        { timeout: 240_000, interval: 500 },
      );
      const resumedTicks = await ticksFor("resumed");
      expect(resumedTicks.slice(1).every((tick) => tick.pid !== firstPid)).toBe(true);
      await vi.waitFor(
        async () =>
          expect((await gateway.jobs()).find((entry) => entry.id === resumed)).toMatchObject({
            enabled: false,
          }),
        { timeout: 30_000, interval: 200 },
      );

      // A schedule whose plugin is disabled while the Gateway is down never fires again.
      const disabledPlugin = await gateway.schedule("plugin-disabled");
      await gateway.client.stopAndWait();
      await instance.stopGateway();
      // While the Gateway is down, the operator disables the plugin.
      // Edit the instance's written config, which also carries its Gateway auth.
      const written = JSON.parse(await fs.readFile(instance.configPath, "utf8")) as typeof config;
      await instance.state.writeConfig({
        ...written,
        plugins: { ...written.plugins, entries: { [PLUGIN_ID]: { enabled: false } } },
      });
      await instance.startGateway();
      gateway = await connect();
      // Claim an occurrence now rather than waiting for its slot: the claim finds no matching
      // loaded plugin and retires the schedule without running plugin code.
      await gateway.client.request("cron.run", { id: disabledPlugin, mode: "force" });
      await vi.waitFor(
        async () =>
          expect(
            (await gateway.jobs()).find((entry) => entry.id === disabledPlugin),
            instance.logs(),
          ).toMatchObject({ enabled: false }),
        { timeout: 60_000, interval: 200 },
      );
      expect(await ticksFor("resumed")).toHaveLength(MAX_RUNS);
      expect(await ticksFor("cancelled")).toEqual([]);
      expect(await ticksFor("plugin-disabled")).toEqual([]);
      const finalJobs = await gateway.jobs();
      for (const id of [resumed, cancelled, disabledPlugin]) {
        expect(finalJobs.find((entry) => entry.id === id)).toMatchObject({ enabled: false });
      }
      expect(modelRequests).toEqual([]);
      await gateway.client.stopAndWait();
    } catch (error) {
      throw new Error(String(error) + "\n" + instance.logs(), { cause: error });
    }
  },
);
