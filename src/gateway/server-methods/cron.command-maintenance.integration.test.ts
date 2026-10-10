import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveCronJobConfigRevision } from "../../cron/config-revision.js";
import { CronService } from "../../cron/service.js";
import { setupCronServiceSuite } from "../../cron/service.test-harness.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  registerAgentRunContext,
  clearAgentRunContext,
} from "../../infra/agent-run-registry.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { cronHandlers } from "./cron.js";
import type { GatewayClient, RespondFn } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-command-maintenance-rpc-",
});
const cfg = { agents: { entries: { main: {} } } };
beforeEach(() => setRuntimeConfigSnapshot(cfg));
afterEach(clearRuntimeConfigSnapshot);

it("admits only operator exact revision-checked command pauses through the native handler", async () => {
  const { storePath } = await makeStorePath();
  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    nowMs: () => Date.now(),
    defaultAgentId: "main",
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
  const scopedRunId = "maintenance-scoped";
  const scopedRun = createOperationalRunInstanceRef(scopedRunId);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(scopedRun);
  registerAgentRunContext(scopedRunId, {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "maintenance-session",
  });
  try {
    const job = await cron.add({
      enabled: true,
      name: "Harmless maintenance command",
      agentId: "main",
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "command", argv: ["true"] },
      delivery: { mode: "none" },
    });
    const context = createDirectChatContext({
      cron,
      cronStorePath: storePath,
      getRuntimeConfig: () => cfg,
    });
    const operator = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    const scoped = createSyntheticPluginRuntimeClient();
    scoped.internal!.agentRuntimeIdentity = {
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: scopedRun,
      delegatedAuthority: { kind: "local", ...delegatedAuthority },
    };
    const base = {
      id: job.id,
      preserveRunning: true,
      expectedConfigRevision: resolveCronJobConfigRevision(job),
      patch: { enabled: false },
    };
    const update = async (params: Record<string, unknown>, client: GatewayClient = operator) => {
      const respond = vi.fn<RespondFn>();
      await cronHandlers["cron.update"]!({
        req: { type: "req", id: "maintenance", method: "cron.update", params },
        params,
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      return expectDefined(respond.mock.calls[0], "native maintenance update response");
    };
    for (const params of [
      { ...base, expectedConfigRevision: undefined },
      { ...base, expectedConfigRevision: "0".repeat(64) },
      { ...base, patch: { enabled: false, description: "mixed" } },
      { ...base, patch: { enabled: true } },
    ]) {
      expect((await update(params))[0]).toBe(false);
      expect(await cron.readJob(job.id)).toEqual(job);
    }
    expect((await update(base, scoped))[0]).toBe(false);
    expect(await cron.readJob(job.id)).toEqual(job);
    const [ok, result] = await update(base);
    expect(ok).toBe(true);
    expect(result).toMatchObject({ enabled: false });
    expect(result).not.toHaveProperty("preserveRunning");
    const noncommand = await cron.update(job.id, {
      payload: { kind: "agentTurn", message: "No command" },
      enabled: true,
    });
    expect(
      (
        await update({ ...base, expectedConfigRevision: resolveCronJobConfigRevision(noncommand) })
      )[0],
    ).toBe(false);
    expect(await cron.readJob(job.id)).toEqual(noncommand);
  } finally {
    releaseAgentRunDelegatedAuthority(delegatedAuthority);
    clearAgentRunContext(scopedRunId);
    cron.stop();
  }
});
