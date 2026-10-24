import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
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

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`stream process ${pid} remained alive`);
}

function createAuthorityTool(creatorToolAllowlist: CronToolOptions["creatorToolAllowlist"]) {
  return createCronTool({
    creatorToolAllowlist,
    execOverrides: { host: "gateway", security: "full", ask: "off" },
    sandboxed: false,
  });
}

function seedRestartExhaustedStream(instance: OpenClawTestInstance, jobId: string): void {
  using database = new DatabaseSync(path.join(instance.stateDir, "state", "openclaw.sqlite"));
  const result = database
    .prepare(`
    UPDATE cron_jobs SET enabled = 1,
      job_json = json_set(job_json, '$.enabled', json('true')),
      state_json = json_set(state_json, '$.streamStatus', 'error',
        '$.streamRestartExhausted', json('true'), '$.streamConsecutiveFailures', 5)
    WHERE job_id = ?
  `)
    .run(jobId);
  expect(result.changes).toBe(1);
}

describe("cron stream agent authority final effects", () => {
  it("proves allowed, forbidden, activation, and stale authority through a real Gateway process", async () => {
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
        const execute = (tool: ReturnType<typeof createCronTool>, args: Record<string, unknown>) =>
          tool.execute("stream-proof", {
            gatewayUrl: instance.url,
            gatewayToken: instance.gatewayToken,
            ...args,
          });
        const deny = async (
          tool: ReturnType<typeof createCronTool>,
          args: Record<string, unknown>,
          expectedMethods?: string[],
          hooks: Partial<Record<"before" | "after", (method: string) => Promise<void>>> = {},
        ) => {
          const methods: string[] = [];
          using _ = vi
            .spyOn(gatewayModule, "callGatewayTool")
            .mockImplementation(async (...callArgs) => {
              methods.push(callArgs[0]);
              await hooks.before?.(callArgs[0]);
              const result = await callGatewayTool(...callArgs);
              await hooks.after?.(callArgs[0]);
              return result;
            });
          await expect(execute(tool, args)).rejects.toThrow("Gateway exec authority");
          if (expectedMethods) {
            expect(methods).toEqual(expectedMethods);
          }
        };

        await execute(strong, { action: "add", job: streamInput });
        const createdJobs = await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"]);
        const created = createdJobs.jobs.find((job) => job.name === streamInput.name);
        expect(created).toBeDefined();
        if (!created) {
          throw new Error("authorized stream was not persisted");
        }
        const readJob = () => cliJson<CronJob>(instance, ["cron", "get", created.id]);
        const denyUpdate = (
          tool: ReturnType<typeof createCronTool>,
          job: Record<string, unknown>,
          methods?: string[],
        ) => deny(tool, { action: "update", jobId: created.id, job }, methods);
        const firstPid = await waitForPid(pidPath, undefined, async () => {
          const current = await readJob();
          return `job=${JSON.stringify(current)}\ngateway logs:\n${instance.logs()}`;
        });

        const persistedCount = createdJobs.jobs.length;
        await deny(
          createAuthorityTool([{ name: "exec", execOrigin: "native" }]),
          {
            action: "add",
            job: { ...streamInput, name: "denied remote native authority stream" },
          },
          [],
        );
        expect((await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"])).jobs).toHaveLength(
          persistedCount,
        );
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(firstPid);
        process.kill(firstPid, 0);

        await deny(weak, {
          action: "add",
          job: { ...streamInput, name: "denied authority stream" },
        });
        expect((await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"])).jobs).toHaveLength(
          persistedCount,
        );

        await cliJson(instance, ["cron", "disable", created.id]);
        await waitForDead(firstPid);
        await denyUpdate(weak, { enabled: true });
        expect((await readJob()).enabled).toBe(false);

        await execute(strong, { action: "update", jobId: created.id, job: { enabled: true } });
        const secondPid = await waitForPid(pidPath, firstPid);
        expect((await readJob()).enabled).toBe(true);

        await denyUpdate(
          createAuthorityTool(["read"]),
          { schedule: { kind: "stream", command: streamInput.schedule.command } },
          ["cron.get"],
        );
        const afterOmittedFieldDenial = await readJob();
        expect(afterOmittedFieldDenial.schedule).toEqual(streamInput.schedule);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(secondPid);
        process.kill(secondPid, 0);

        const denyRacingUpdate = async (
          method: string,
          phase: "before" | "after",
          patch: Record<string, unknown>,
          job: Record<string, unknown>,
          expectedMethods?: string[],
        ) => {
          let injected = false;
          const inject = async (currentMethod: string) => {
            if (method === currentMethod && !injected) {
              injected = true;
              await callGatewayTool(
                "cron.update",
                {
                  gatewayUrl: instance.url,
                  gatewayToken: instance.gatewayToken,
                },
                { id: created.id, patch },
              );
            }
          };
          await deny(weak, { action: "update", jobId: created.id, job }, expectedMethods, {
            [phase]: inject,
          });
          expect(injected).toBe(true);
        };
        const conflictSchedule = {
          ...streamInput.schedule,
          mode: "match" as const,
          match: "event",
        };
        await denyRacingUpdate(
          "cron.update",
          "before",
          { schedule: conflictSchedule },
          { schedule: streamInput.schedule },
        );
        const thirdPid = await waitForPid(pidPath, secondPid);
        expect((await readJob()).schedule).toEqual(conflictSchedule);

        await denyRacingUpdate(
          "cron.get",
          "after",
          { state: { streamRestartExhausted: true } },
          { enabled: true },
          ["cron.get"],
        );
        await waitForDead(thirdPid);
        const racedExhausted = await readJob();
        expect(racedExhausted.state.streamRestartExhausted).toBe(true);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(thirdPid);

        await instance.stopGateway();
        seedRestartExhaustedStream(instance, created.id);
        await instance.startGateway();
        const exhausted = await readJob();
        expect(exhausted.enabled).toBe(true);
        expect(exhausted.state.streamRestartExhausted).toBe(true);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(thirdPid);

        await denyUpdate(
          createAuthorityTool(["read"]),
          { state: { streamRestartExhausted: false } },
          ["cron.get"],
        );

        await denyUpdate(weak, { enabled: true });
        const stillExhausted = await readJob();
        expect(stillExhausted.enabled).toBe(true);
        expect(stillExhausted.state.streamRestartExhausted).toBe(true);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(thirdPid);

        await proveHostStreamApprovalEffects({ instance, provider, waitForPid, waitForDead });
      },
      () => instance.cleanup(),
    );
  });
});
