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
import type { AgentRuntimeIdentity } from "../../gateway/agent-runtime-identity-token.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { createCronTool } from "./cron-tool.js";
import {
  createHostStreamApprovalProvider,
  proveHostStreamApprovalEffects,
} from "./cron-tool.stream-exec-policy.e2e.test-support.js";
import type { GatewayToolCaller } from "./cron-tool.types.js";
import {
  withGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import * as gatewayModule from "./gateway.js";
import type { GatewayCallOptions } from "./gateway.js";

const callGatewayTool = gatewayModule.callGatewayTool;

async function cliJson<T>(instance: OpenClawTestInstance, args: string[]): Promise<T> {
  const result = await instance.cli(
    [...args, "--url", instance.url, "--token", instance.gatewayToken, "--json"],
    { timeoutMs: 30_000 },
  );
  expect(
    result.code,
    `${result.stderr}
${result.stdout}`,
  ).toBe(0);
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

function toolArgs(instance: OpenClawTestInstance) {
  return { gatewayUrl: instance.url, gatewayToken: instance.gatewayToken };
}

function createStrongTool() {
  return createCronTool({
    creatorToolAllowlist: [{ name: "exec", execOrigin: "openclaw" }],
    execOverrides: { host: "gateway", security: "full", ask: "off" },
    sandboxed: false,
  });
}

function createWeakTool() {
  return createCronTool({
    creatorToolAllowlist: ["read"],
    execOverrides: { host: "gateway", security: "full", ask: "off" },
    sandboxed: false,
  });
}

function createRemoteNativeOnlyTool() {
  return createCronTool({
    creatorToolAllowlist: [{ name: "exec", execOrigin: "native" }],
    // Remote Codex placement is independent of these OpenClaw defaults.
    execOverrides: { host: "gateway", security: "full", ask: "off" },
    sandboxed: false,
  });
}

async function withWeakManagementTool<T>(
  run: (tool: ReturnType<typeof createCronTool>) => Promise<T>,
): Promise<T> {
  const runId = "cron-stream-management-authority";
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capability = createCronCreatorAuthorityCapability(
    runId,
    { kind: "unknown" },
    { source: "control-ui-admin" },
  );
  if (!capability) {
    throw new Error("expected management authority capability");
  }
  const identity: AgentRuntimeIdentity = {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:control-ui",
    operationalRunInstance,
    delegatedAuthority: { ...authority, kind: "local" },
  };
  try {
    using _ = vi
      .spyOn(gatewayModule, "callGatewayTool")
      .mockImplementation((...args) =>
        withoutGatewayToolCallerIdentity(() => callGatewayTool(...args)),
      );
    return await runWithCronCreatorAuthorityCapability(capability, () =>
      withGatewayToolCallerIdentity({ ...identity, approvalAuthority: authority }, () =>
        run(
          createCronTool({
            runId,
            agentSessionKey: identity.sessionKey,
            creatorToolAllowlist: ["read"],
            execOverrides: { host: "gateway", security: "full", ask: "off" },
            sandboxed: false,
          }),
        ),
      ),
    );
  } finally {
    releaseAgentRunDelegatedAuthority(authority);
  }
}

function seedRestartExhaustedStream(instance: OpenClawTestInstance, jobId: string): void {
  const database = new DatabaseSync(path.join(instance.stateDir, "state", "openclaw.sqlite"));
  try {
    const row = database
      .prepare("SELECT job_json, state_json FROM cron_jobs WHERE job_id = ?")
      .get(jobId) as { job_json: string; state_json: string } | undefined;
    if (!row) {
      throw new Error(`cron row not found: ${jobId}`);
    }
    const job = JSON.parse(row.job_json) as Record<string, unknown>;
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    job.enabled = true;
    Object.assign(state, {
      streamStatus: "error",
      streamRestartExhausted: true,
      streamConsecutiveFailures: 5,
    });
    const result = database
      .prepare("UPDATE cron_jobs SET enabled = 1, job_json = ?, state_json = ? WHERE job_id = ?")
      .run(JSON.stringify(job), JSON.stringify(state), jobId);
    if (result.changes !== 1) {
      throw new Error(`expected one exhausted cron row update, got ${result.changes}`);
    }
  } finally {
    database.close();
  }
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
        const strong = createStrongTool();
        const weak = createWeakTool();

        await strong.execute("allowed-create", {
          action: "add",
          ...toolArgs(instance),
          job: streamInput,
        });
        const createdJobs = await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"]);
        const created = createdJobs.jobs.find((job) => job.name === streamInput.name);
        expect(created).toBeDefined();
        if (!created) {
          throw new Error("authorized stream was not persisted");
        }
        const firstPid = await waitForPid(pidPath, undefined, async () => {
          const current = await cliJson<CronJob>(instance, ["cron", "get", created.id]);
          return `job=${JSON.stringify(current)}\ngateway logs:\n${instance.logs()}`;
        });

        const persistedCount = createdJobs.jobs.length;
        let remoteNativeGatewayCalls = 0;
        {
          using _ = vi
            .spyOn(gatewayModule, "callGatewayTool")
            .mockImplementation(async (...args) => {
              remoteNativeGatewayCalls += 1;
              return await callGatewayTool(...args);
            });
          await expect(
            createRemoteNativeOnlyTool().execute("denied-remote-native-create", {
              action: "add",
              ...toolArgs(instance),
              job: { ...streamInput, name: "denied remote native authority stream" },
            }),
          ).rejects.toThrow("Gateway exec authority");
        }
        expect(remoteNativeGatewayCalls).toBe(0);
        expect((await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"])).jobs).toHaveLength(
          persistedCount,
        );
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(firstPid);
        process.kill(firstPid, 0);

        await expect(
          weak.execute("denied-create", {
            action: "add",
            ...toolArgs(instance),
            job: { ...streamInput, name: "denied authority stream" },
          }),
        ).rejects.toThrow("Gateway exec authority");
        expect((await cliJson<{ jobs: CronJob[] }>(instance, ["cron", "list"])).jobs).toHaveLength(
          persistedCount,
        );

        await cliJson(instance, ["cron", "disable", created.id]);
        await waitForDead(firstPid);
        await withWeakManagementTool(async (management) => {
          await expect(
            management.execute("denied-management-enable", {
              action: "update",
              ...toolArgs(instance),
              jobId: created.id,
              job: { enabled: true },
            }),
          ).rejects.toThrow("Gateway exec authority");
        });
        expect((await cliJson<CronJob>(instance, ["cron", "get", created.id])).enabled).toBe(false);

        await expect(
          weak.execute("denied-enable", {
            action: "update",
            ...toolArgs(instance),
            jobId: created.id,
            job: { enabled: true },
          }),
        ).rejects.toThrow("Gateway exec authority");
        expect((await cliJson<CronJob>(instance, ["cron", "get", created.id])).enabled).toBe(false);

        await strong.execute("allowed-enable", {
          action: "update",
          ...toolArgs(instance),
          jobId: created.id,
          job: { enabled: true },
        });
        const secondPid = await waitForPid(pidPath, firstPid);
        expect((await cliJson<CronJob>(instance, ["cron", "get", created.id])).enabled).toBe(true);

        const omittedFieldGatewayMethods: string[] = [];
        {
          using _ = vi
            .spyOn(gatewayModule, "callGatewayTool")
            .mockImplementation(async (method, opts, params, extra) => {
              omittedFieldGatewayMethods.push(method);
              return await callGatewayTool(method, opts, params, extra);
            });
          await expect(
            createWeakTool().execute("denied-omitted-cwd", {
              action: "update",
              ...toolArgs(instance),
              jobId: created.id,
              job: {
                schedule: { kind: "stream", command: streamInput.schedule.command },
              },
            }),
          ).rejects.toThrow("Gateway exec authority");
        }
        expect(omittedFieldGatewayMethods).toEqual(["cron.get"]);
        const afterOmittedFieldDenial = await cliJson<CronJob>(instance, [
          "cron",
          "get",
          created.id,
        ]);
        expect(afterOmittedFieldDenial.schedule).toEqual(streamInput.schedule);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(secondPid);
        process.kill(secondPid, 0);

        const conflictSchedule = {
          ...streamInput.schedule,
          mode: "match" as const,
          match: "event",
        };
        let injectedConflict = false;
        const conflictCaller: GatewayToolCaller = async (method, opts, params, extra) => {
          if (method === "cron.update" && !injectedConflict) {
            injectedConflict = true;
            await callGatewayTool("cron.update", opts, {
              id: created.id,
              patch: { schedule: conflictSchedule },
            });
          }
          return await callGatewayTool(method, opts, params, extra);
        };
        {
          using _ = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(conflictCaller);
          await expect(
            weak.execute("stale-source-resave", {
              action: "update",
              ...toolArgs(instance),
              jobId: created.id,
              job: { schedule: streamInput.schedule },
            }),
          ).rejects.toThrow("Gateway exec authority");
        }
        const thirdPid = await waitForPid(pidPath, secondPid);
        expect(injectedConflict).toBe(true);
        expect((await cliJson<CronJob>(instance, ["cron", "get", created.id])).schedule).toEqual(
          conflictSchedule,
        );

        const exhaustionRaceGatewayMethods: string[] = [];
        let injectedExhaustion = false;
        const exhaustionRaceCaller: GatewayToolCaller = async <T = Record<string, unknown>>(
          method: string,
          opts: GatewayCallOptions,
          params?: unknown,
          extra?: Parameters<typeof callGatewayTool>[3],
        ): Promise<T> => {
          exhaustionRaceGatewayMethods.push(method);
          const result = await callGatewayTool<T>(method, opts, params, extra);
          if (method === "cron.get" && !injectedExhaustion) {
            injectedExhaustion = true;
            await callGatewayTool("cron.update", opts, {
              id: created.id,
              patch: { state: { streamRestartExhausted: true } },
            });
          }
          return result;
        };
        {
          using _ = vi
            .spyOn(gatewayModule, "callGatewayTool")
            .mockImplementation(exhaustionRaceCaller);
          await expect(
            weak.execute("denied-exhaustion-race-enable", {
              action: "update",
              ...toolArgs(instance),
              jobId: created.id,
              job: { enabled: true },
            }),
          ).rejects.toThrow("Gateway exec authority");
        }
        expect(exhaustionRaceGatewayMethods).toEqual(["cron.get"]);
        await waitForDead(thirdPid);
        const racedExhausted = await cliJson<CronJob>(instance, ["cron", "get", created.id]);
        expect(racedExhausted.state.streamRestartExhausted).toBe(true);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(thirdPid);

        await instance.stopGateway();
        seedRestartExhaustedStream(instance, created.id);
        await instance.startGateway();
        const exhausted = await cliJson<CronJob>(instance, ["cron", "get", created.id]);
        expect(exhausted.enabled).toBe(true);
        expect(exhausted.state.streamRestartExhausted).toBe(true);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(thirdPid);

        const stateRecoveryGatewayMethods: string[] = [];
        {
          using _ = vi
            .spyOn(gatewayModule, "callGatewayTool")
            .mockImplementation(async (method, opts, params, extra) => {
              stateRecoveryGatewayMethods.push(method);
              return await callGatewayTool(method, opts, params, extra);
            });
          await expect(
            createWeakTool().execute("denied-state-only-recovery", {
              action: "update",
              ...toolArgs(instance),
              jobId: created.id,
              job: { state: { streamRestartExhausted: false } },
            }),
          ).rejects.toThrow("Gateway exec authority");
        }
        expect(stateRecoveryGatewayMethods).toEqual(["cron.get"]);

        await expect(
          weak.execute("denied-exhausted-recovery", {
            action: "update",
            ...toolArgs(instance),
            jobId: created.id,
            job: { enabled: true },
          }),
        ).rejects.toThrow("Gateway exec authority");
        const stillExhausted = await cliJson<CronJob>(instance, ["cron", "get", created.id]);
        expect(stillExhausted.enabled).toBe(true);
        expect(stillExhausted.state.streamRestartExhausted).toBe(true);
        expect(Number(await fs.readFile(pidPath, "utf8"))).toBe(thirdPid);

        await proveHostStreamApprovalEffects({ instance, provider, waitForPid, waitForDead });
      },
      () => instance.cleanup(),
    );
  });
});
