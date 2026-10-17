// Real Gateway WS proof: standing-grant card (128/256) and grants.list (512)
// previews stay surrogate-safe when emoji sit on the UTF-16 display caps.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { resolveCronJobConfigRevision } from "../cron/config-revision.js";
import {
  loadCronRows,
  loadedCronStoreFromRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import type { CronStoredJob } from "../cron/types.js";
import { registerCronRunExecSource } from "../infra/cron-run-exec-source.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const CRON_STORE_KEY = "cron-utf16-ws-proof";
const LOBSTER = "🦞";
const NOW_MS = 1_756_000_000_000;

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;

type StandingGrantScope = {
  kind?: string;
  automation?: string;
  command?: string;
};

type ApprovalRequestedPayload = {
  id?: string;
  request?: {
    scope?: StandingGrantScope | null;
    command?: string;
  };
};

type GrantsListPayload = {
  grants?: Array<{
    command?: string;
    cwd?: string | null;
    cronJobId?: string;
  }>;
};

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function seedCronJob(jobName: string): { jobId: string; revision: string } {
  const jobId = "job-utf16-ws";
  const job = {
    id: jobId,
    agentId: "main",
    name: jobName,
    enabled: true,
    createdAtMs: NOW_MS - 1_000,
    updatedAtMs: NOW_MS - 1_000,
    schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run the backup" },
    state: {},
  } as CronStoredJob;
  const database = openOpenClawStateDatabase();
  upsertCronJobRow(database.db, CRON_STORE_KEY, job, 0);
  const loaded = loadedCronStoreFromRows(loadCronRows(database.db, CRON_STORE_KEY));
  const loadedJob = loaded.store.jobs.find((entry) => entry.id === jobId);
  if (!loadedJob) {
    throw new Error(`seeded cron job ${jobId} did not load back`);
  }
  return { jobId, revision: resolveCronJobConfigRevision(loadedJob) };
}

describe("Gateway WS exec approval UTF-16 display bounds", () => {
  const sockets: WebSocket[] = [];
  let gateway: GatewayHarness | undefined;
  let unregisterCronSource: (() => void) | undefined;

  afterEach(async () => {
    unregisterCronSource?.();
    unregisterCronSource = undefined;
    for (const ws of sockets.splice(0)) {
      ws.terminate();
    }
    await gateway?.close();
    gateway = undefined;
  });

  it("delivers surrogate-safe standing-grant card previews and grants.list caps over WS", async () => {
    const jobName = `${"n".repeat(127)}${LOBSTER}`;
    // Card command cap is 256: emoji must sit on that boundary.
    const cardCommand = `${"a".repeat(255)}${LOBSTER}`;
    // Grant listing caps are 512 for command/cwd.
    const listCommand = `${"c".repeat(511)}${LOBSTER}`;
    const listCwd = `${"b".repeat(511)}${LOBSTER}`;
    const cardRunId = `run-utf16-card-${randomUUID()}`;
    const listRunId = `run-utf16-list-${randomUUID()}`;
    const cardApprovalId = `approval-utf16-card-${randomUUID()}`;
    const listApprovalId = `approval-utf16-list-${randomUUID()}`;

    gateway = await createGatewaySuiteHarness({
      serverOptions: { bind: "loopback", auth: { mode: "none" } },
    });
    await gateway.server.startupSettled;

    const { jobId, revision } = seedCronJob(jobName);

    const observer = await gateway.openWs();
    sockets.push(observer);
    await connectOk(observer, {
      scopes: ["operator.admin"],
      caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
    });

    const requester = await gateway.openWs();
    sockets.push(requester);
    await connectOk(requester, { scopes: ["operator.admin"] });

    unregisterCronSource = registerCronRunExecSource(cardRunId, {
      agentId: "main",
      jobId,
      jobConfigRevision: revision,
      jobName,
    });

    const cardRequested = onceMessage<{
      type: string;
      event?: string;
      payload?: ApprovalRequestedPayload;
    }>(
      observer,
      (message) =>
        message.type === "event" &&
        message.event === "exec.approval.requested" &&
        message.payload?.id === cardApprovalId,
      30_000,
    );

    const cardAccepted = await rpcReq<{ id: string; status: string; deliveryRoute?: string }>(
      requester,
      "exec.approval.request",
      {
        id: cardApprovalId,
        command: cardCommand,
        host: "gateway",
        agentId: "main",
        runId: cardRunId,
        twoPhase: true,
        // Approval-capable observer is the delivery route; do not suppress the card.
        timeoutMs: 120_000,
      },
      30_000,
    );
    expect(cardAccepted.ok).toBe(true);
    expect(cardAccepted.payload?.status).toBe("accepted");
    expect(cardAccepted.payload?.deliveryRoute).toBe("approval-client");

    const cardEvent = await cardRequested;
    const scope = cardEvent.payload?.request?.scope;
    expect(scope?.kind).toBe("standing-grant");
    const automation = scope?.automation ?? "";
    const scopedCommand = scope?.command ?? "";
    expect(hasUnpairedSurrogate(automation)).toBe(false);
    expect(hasUnpairedSurrogate(scopedCommand)).toBe(false);
    expect(automation).toBe("n".repeat(127));
    expect(scopedCommand).toBe("a".repeat(255));
    expect(automation).not.toContain(LOBSTER);
    expect(scopedCommand).not.toContain(LOBSTER);
    console.log(
      `[gateway-ws exec.approval.requested standing-grant card utf16 proof] deliveryRoute=approval-client automation_len=${automation.length} command_len=${scopedCommand.length} unpaired=false boundaries=128,256`,
    );

    const denied = await rpcReq<{ ok?: boolean }>(
      observer,
      "exec.approval.resolve",
      { id: cardApprovalId, decision: "deny" },
      30_000,
    );
    expect(denied.ok).toBe(true);

    unregisterCronSource();
    unregisterCronSource = registerCronRunExecSource(listRunId, {
      agentId: "main",
      jobId,
      jobConfigRevision: revision,
      jobName,
    });

    const listRequested = onceMessage<{
      type: string;
      event?: string;
      payload?: ApprovalRequestedPayload;
    }>(
      observer,
      (message) =>
        message.type === "event" &&
        message.event === "exec.approval.requested" &&
        message.payload?.id === listApprovalId,
      30_000,
    );

    const listAccepted = await rpcReq<{ id: string; status: string; deliveryRoute?: string }>(
      requester,
      "exec.approval.request",
      {
        id: listApprovalId,
        command: listCommand,
        cwd: listCwd,
        host: "gateway",
        agentId: "main",
        runId: listRunId,
        twoPhase: true,
        timeoutMs: 120_000,
      },
      30_000,
    );
    expect(listAccepted.ok).toBe(true);
    expect(listAccepted.payload?.status).toBe("accepted");
    expect(listAccepted.payload?.deliveryRoute).toBe("approval-client");
    await listRequested;

    const resolved = await rpcReq<{ ok?: boolean }>(
      observer,
      "exec.approval.resolve",
      { id: listApprovalId, decision: "allow-always" },
      30_000,
    );
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.ok).toBe(true);

    const listed = await rpcReq<GrantsListPayload>(
      observer,
      "exec.approval.grants.list",
      {},
      30_000,
    );
    expect(listed.ok).toBe(true);
    const grant = listed.payload?.grants?.find((entry) => entry.cronJobId === jobId);
    expect(grant).toBeDefined();
    const listedCommand = grant?.command ?? "";
    const listedCwd = grant?.cwd ?? "";
    expect(hasUnpairedSurrogate(listedCommand)).toBe(false);
    expect(hasUnpairedSurrogate(listedCwd)).toBe(false);
    expect(listedCommand).toBe("c".repeat(511));
    expect(listedCwd).toBe("b".repeat(511));
    expect(listedCommand).not.toContain(LOBSTER);
    expect(listedCwd).not.toContain(LOBSTER);
    console.log(
      `[gateway-ws exec.approval.grants.list utf16 proof] listen=loopback transport=ws store=real-sqlite command_len=${listedCommand.length} cwd_len=${listedCwd.length} unpaired=false boundary=512`,
    );
  }, 180_000);
});
