import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForDead as waitForProcessDeath } from "../../../test/helpers/process-wait.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import { captureRuntimeConfigAsyncReader } from "../../config/config.js";
import type { CronJob } from "../../cron/types.js";
import { createCronTool } from "./cron-tool.js";
import {
  createHostStreamApprovalProvider,
  proveHostStreamApprovalEffects,
} from "./cron-tool.stream-exec-policy.e2e.test-support.js";
import type { CronToolOptions } from "./cron-tool.types.js";
import * as gatewayModule from "./gateway.js";

const callGatewayTool = gatewayModule.callGatewayTool;

async function cliJson<T>(instance: OpenClawTestInstance, args: string[]): Promise<T> {
  const result = await instance.cli(
    [...args, "--url", instance.url, "--token", instance.gatewayToken, "--json"],
    { timeoutMs: 30_000 },
  );
  expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
  return JSON.parse(result.stdout) as T;
}

async function waitForPid(
  pathname: string,
  previous?: number,
  describeFailure?: () => Promise<string>,
): Promise<number> {
  const deadline = Date.now() + 10_000;
  do {
    try {
      const pid = Number(await fs.readFile(pathname, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && pid !== previous) {
        process.kill(pid, 0);
        return pid;
      }
    } catch {
      // The real Gateway process owner has not written the trace yet.
    }
    await delay(50);
  } while (Date.now() < deadline);
  const context = describeFailure ? await describeFailure() : "";
  throw new Error(
    `stream process did not write a live pid to ${pathname}${context ? `\n${context}` : ""}`,
  );
}

const waitForDead = (pid: number) => waitForProcessDeath(pid, AbortSignal.timeout(10_000));

function createAuthorityTool(creatorToolAllowlist: CronToolOptions["creatorToolAllowlist"]) {
  return createCronTool({
    creatorToolAllowlist,
    execOverrides: { host: "gateway", security: "full", ask: "off" },
    sandboxed: false,
  });
}

it("enforces native exec, stale updates, exhausted restart and host approval boundaries", async () => {
  await using provider = await createHostStreamApprovalProvider();
  const { model } = provider;
  const instance = await createOpenClawTestInstance({
    name: "cron-stream-agent-authority",
    env: { OPENCLAW_SKIP_CRON: undefined },
    config: {
      gateway: { mode: "local", controlUi: { allowedOrigins: ["http://localhost"] } },
      tools: {
        allow: ["automations", "exec"],
        exec: { host: "gateway", security: "full", ask: "off" },
        codeMode: false,
        toolSearch: false,
      },
      agents: {
        defaults: {
          model: { primary: model.modelRef },
          modelPolicy: { allow: [model.modelRef] },
          models: {
            [model.modelRef]: {
              agentRuntime: { id: "openclaw" },
              params: { transport: "sse", openaiWsWarmup: false },
            },
          },
          skipBootstrap: true,
          sandbox: { mode: "off" },
        },
      },
      models: { mode: "replace", providers: { [model.providerId]: model.config } },
      cron: { enabled: true, triggers: { enabled: true } },
    },
  });
  await runQaGatewayFixture(
    async () => {
      await instance.startGateway();
      instance.state.applyEnv();
      await captureRuntimeConfigAsyncReader()();

      const pidPath = path.join(instance.state.workspaceDir, "stream-source.pid");
      const source = [
        `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
        "setInterval(() => {}, 1000);",
      ].join("");
      const streamInput = {
        name: "agent authority stream",
        schedule: {
          kind: "stream" as const,
          command: [process.execPath, "-e", source],
          cwd: instance.state.workspaceDir,
        },
        sessionTarget: "isolated" as const,
        wakeMode: "now" as const,
        payload: { kind: "agentTurn" as const, message: "handle events" },
      };
      const strong = createAuthorityTool([{ name: "exec", execOrigin: "openclaw" }]);
      const weak = createAuthorityTool(["read"]);
      const gatewayOptions = { gatewayUrl: instance.url, gatewayToken: instance.gatewayToken };
      const execute = (tool: ReturnType<typeof createCronTool>, args: Record<string, unknown>) =>
        tool.execute("stream-proof", { ...gatewayOptions, ...args });
      const deny = async (
        tool: ReturnType<typeof createCronTool>,
        args: Record<string, unknown>,
        expectedMethods?: string[],
        race?: { method: string; phase: "before" | "after"; patch: Record<string, unknown> },
      ) => {
        const methods: string[] = [];
        let injected = false;
        const inject = async (phase: "before" | "after", method: string) => {
          if (race?.phase === phase && race.method === method && !injected) {
            injected = true;
            await callGatewayTool("cron.update", gatewayOptions, {
              id: args.jobId,
              patch: race.patch,
            });
          }
        };
        using _ = vi
          .spyOn(gatewayModule, "callGatewayTool")
          .mockImplementation(async (...callArgs) => {
            methods.push(callArgs[0]);
            await inject("before", callArgs[0]);
            const result = await callGatewayTool(...callArgs);
            await inject("after", callArgs[0]);
            return result;
          });
        await expect(execute(tool, args)).rejects.toThrow("Gateway exec authority");
        if (expectedMethods) {
          expect(methods).toEqual(expectedMethods);
        }
        if (race) {
          expect(injected).toBe(true);
        }
      };

      await execute(strong, { action: "add", job: streamInput });
      const createdJobs = await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"]);
      const created = createdJobs.jobs.find((job) => job.name === streamInput.name);
      if (!created) {
        throw new Error("authorized stream was not persisted");
      }
      const readJob = () => cliJson<CronJob>(instance, ["cron", "get", created.id]);
      const denyUpdate = (
        job: Record<string, unknown>,
        methods?: string[],
        race?: Parameters<typeof deny>[3],
      ) => deny(weak, { action: "update", jobId: created.id, job }, methods, race);
      const firstPid = await waitForPid(pidPath, undefined, async () => {
        const current = await readJob();
        return `job=${JSON.stringify(current)}\ngateway logs:\n${instance.logs()}`;
      });

      await deny(
        createAuthorityTool([{ name: "exec", execOrigin: "native" }]),
        {
          action: "add",
          job: { ...streamInput, name: "denied remote native authority stream" },
        },
        [],
      );
      expect((await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"])).jobs).toHaveLength(
        createdJobs.jobs.length,
      );
      expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(firstPid);
      process.kill(firstPid, 0);

      const conflictSchedule = {
        ...streamInput.schedule,
        mode: "match" as const,
        match: "event",
      };
      await denyUpdate({ schedule: streamInput.schedule }, undefined, {
        method: "cron.update",
        phase: "before",
        patch: { schedule: conflictSchedule },
      });
      const replacementPid = await waitForPid(pidPath, firstPid);
      expect((await readJob()).schedule).toEqual(conflictSchedule);

      await denyUpdate({ enabled: true }, ["cron.get"], {
        method: "cron.get",
        phase: "after",
        patch: { state: { streamRestartExhausted: true } },
      });
      await waitForDead(replacementPid);
      const racedExhausted = await readJob();
      expect(racedExhausted.state.streamRestartExhausted).toBe(true);
      expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(replacementPid);

      await instance.stopGateway();
      await instance.startGateway();
      const exhausted = await readJob();
      expect(exhausted.enabled).toBe(true);
      expect(exhausted.state.streamRestartExhausted).toBe(true);
      expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(replacementPid);

      await denyUpdate({ state: { streamRestartExhausted: false } }, ["cron.get"]);

      const stillExhausted = await readJob();
      expect(stillExhausted.enabled).toBe(true);
      expect(stillExhausted.state.streamRestartExhausted).toBe(true);
      expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(replacementPid);

      await proveHostStreamApprovalEffects({ instance, provider, waitForPid, waitForDead });
    },
    () => instance.cleanup(),
  );
});
