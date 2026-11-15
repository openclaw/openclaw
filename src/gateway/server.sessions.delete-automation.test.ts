import path from "node:path";
import { expect, test, vi } from "vitest";
import { CronService } from "../cron/service.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
  withCronManagementGrant,
} from "./cron-creator-authority-grant.js";
import { admitGatewayCronOccurrence } from "./server-cron-event-dispatch.js";
import { createCronCallerClient } from "./server-methods/cron.validation.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import {
  createSessionAutomationSource,
  registerSessionAutomationSource,
  sessionHasAutomation,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const key = "agent:main:dashboard:command-owner";
const sessionId = "command-owner";
const reportingKey = "agent:main:dashboard:reports";

async function withAutomations(
  run: (cron: CronService, command: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  const { dir } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { [key]: sessionStoreEntry(sessionId), [reportingKey]: sessionStoreEntry("reports") },
  });
  const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
  const command = vi.fn(async () => ({ status: "ok" as const }));
  const cron = new CronService({
    storePath: path.join(dir, "cron", "jobs.json"),
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    defaultAgentId: "main",
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent() {},
    runIsolatedAgentJob: command,
    runCommandJob: command,
    admitScheduledOccurrence: ({ job }) =>
      admitGatewayCronOccurrence(job, () => ({ cfg, agentId: "main" })),
  });
  const source = createSessionAutomationSource(cron, true);
  registerSessionAutomationSource(source);
  try {
    await run(cron, command);
  } finally {
    unregisterSessionAutomationSource(source);
    cron.stop();
    await cron.waitForIdle();
  }
}

const definition = {
  name: "Nightly backup",
  enabled: true,
  schedule: { kind: "every" as const, everyMs: 60_000 },
  sessionTarget: "isolated" as const,
  wakeMode: "now" as const,
  payload: { kind: "command" as const, argv: ["echo", "synthetic backup"] },
};

const dependentDefinition = {
  ...definition,
  payload: { kind: "agentTurn" as const, message: "Use this conversation's workspace" },
};

test("deleting the creator disables execution dependencies but preserves independent reporting elsewhere", async () => {
  await withAutomations(async (cron, command) => {
    const dependent = await cron.add(dependentDefinition, {
      sourceConversation: { sessionKey: key, sessionId },
    });
    const independent = await cron.add(
      {
        ...definition,
        sessionKey: reportingKey,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      },
      { sourceConversation: { sessionKey: key, sessionId } },
    );
    const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
    expect(sessionHasAutomation(key, cfg, "main")).toBe(true);
    const deleted = await directSessionReq("sessions.delete", { key }, { context: { cron } });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect((await loadSessionEntryAsync(key)).entry).toBeUndefined();
    expect(cron.getJob(dependent.id)?.enabled).toBe(false);
    expect.soft(cron.getJob(independent.id)?.enabled).toBe(true);
    await cron.run(independent.id, "force");
    expect.soft(command).toHaveBeenCalledOnce();
    expect(cron.getJob(independent.id)).toMatchObject({
      enabled: true,
      delivery: { channel: "telegram", to: "123" },
      state: { lastRunStatus: "ok" },
    });
    command.mockClear();
    await cron.update(dependent.id, { enabled: true });
    await cron.run(dependent.id, "force");
    expect(command).not.toHaveBeenCalled();
    expect(cron.getJob(dependent.id)).toMatchObject({
      enabled: false,
      state: { lastRunStatus: "skipped" },
    });
  });
});

test("deleting a reporting conversation leaves execution elsewhere enabled", async () => {
  await withAutomations(async (cron, command) => {
    const job = await cron.add(
      { ...dependentDefinition, sessionKey: reportingKey },
      { sourceConversation: { sessionKey: key, sessionId } },
    );
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: reportingKey },
      { context: { cron } },
    );
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(cron.getJob(job.id)?.enabled).toBe(true);
    await cron.run(job.id, "force");
    expect(command).toHaveBeenCalledOnce();
    expect((await loadSessionEntryAsync(reportingKey)).entry).toBeUndefined();
  });
});

test("deleting an explicit execution target disables its automation, not its creator", async () => {
  await withAutomations(async (cron) => {
    const job = await cron.add(
      { ...dependentDefinition, sessionTarget: `session:${reportingKey}` },
      { sourceConversation: { sessionKey: key, sessionId } },
    );
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: reportingKey },
      { context: { cron } },
    );
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(cron.getJob(job.id)?.enabled).toBe(false);
    expect((await loadSessionEntryAsync(key)).entry?.sessionId).toBe(sessionId);
  });
});

test("a failed automation disable keeps the conversation and reports partial progress", async () => {
  await withAutomations(async (cron) => {
    const first = await cron.add(dependentDefinition, {
      sourceConversation: { sessionKey: key, sessionId },
    });
    const second = await cron.add(
      { ...dependentDefinition, name: "Second backup" },
      { sourceConversation: { sessionKey: key, sessionId } },
    );
    const update = cron.updateWithPrecondition.bind(cron);
    vi.spyOn(cron, "updateWithPrecondition").mockImplementation(async (...args) => {
      if (args[0] === first.id) {
        throw new Error("synthetic persistence refusal");
      }
      return update(...args);
    });
    const deleted = await directSessionReq("sessions.delete", { key }, { context: { cron } });
    expect(deleted).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not deleted") },
    });
    expect((await loadSessionEntryAsync(key)).entry?.sessionId).toBe(sessionId);
    expect(cron.getJob(first.id)?.enabled).toBe(true);
    expect(cron.getJob(second.id)?.enabled).toBe(false);
  });
});

test.each([
  ["without automation access", ["operator.sessions.write"], true, false],
  ["with another human's automation", ["operator.sessions.write", "operator.cron"], false, false],
  [
    "with the human owner's automation access",
    ["operator.sessions.write", "operator.cron"],
    true,
    true,
  ],
] as const)(
  "deletion %s preserves automation authority",
  async (_label, scopes, ownsJob, allowed) => {
    await withAutomations(async (cron) => {
      const owner = ensureProfileForEmail("automation-owner@example.test");
      const other = ensureProfileForEmail("automation-other@example.test");
      // Normal Gateway admission prepares the resident catalog before handlers run.
      await prepareUserProfileCatalog();
      const job = await cron.add(dependentDefinition, {
        sourceConversation: { sessionKey: key, sessionId },
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
      const result = await directSessionReq(
        "sessions.delete",
        { key },
        {
          context: { cron },
          client: {
            connect: gatewayConnect([...scopes]),
            authenticatedUserProfile: gatewayProfile(ownsJob ? owner.id : other.id),
          },
        },
      );
      expect(job.ownerProfileId).toBe(owner.id);
      expect(result.ok, JSON.stringify(result.error)).toBe(allowed);
      expect(cron.getJob(job.id)?.enabled).toBe(!allowed);
      expect((await loadSessionEntryAsync(key)).entry?.sessionId).toBe(
        allowed ? undefined : sessionId,
      );
    });
  },
);

test.each([false, true])(
  "deletion honors model command-job policy (allowed=%s)",
  async (allowed) => {
    await withAutomations(async (cron) => {
      const job = await cron.add(
        { ...definition, trigger: { script: "return { fire: true };" } },
        {
          sourceConversation: { sessionKey: key, sessionId },
        },
      );
      const cfg = (await getGatewayConfigModule()).getRuntimeConfig();
      const client = createCronCallerClient("main", "default", key);
      client.connect = gatewayConnect(["operator.admin"]);
      const identity = client.internal!.agentRuntimeIdentity!;
      const { kind: _kind, ...authority } = identity.delegatedAuthority;
      const scope = createCronCreatorAuthorityRunScope(
        identity.operationalRunInstance.runId,
        { kind: "local" },
        { source: "control-ui-admin" },
      );
      try {
        const grant = mintCronCreatorAuthorityGrant(scope, undefined, undefined, {
          method: "cron.update",
          authority,
        });
        const result = await withCronManagementGrant(grant, identity, "cron.update", () =>
          directSessionReq(
            "sessions.delete",
            { key },
            {
              client,
              context: {
                cron,
                getRuntimeConfig: () => ({
                  ...cfg,
                  tools: {
                    ...cfg.tools,
                    gatewayPolicy: { automations: { allowCommandJobs: allowed } },
                  },
                }),
              },
            },
          ),
        );
        expect(result.ok).toBe(allowed);
        expect(cron.getJob(job.id)?.enabled).toBe(!allowed);
        expect((await loadSessionEntryAsync(key)).entry?.sessionId).toBe(
          allowed ? undefined : sessionId,
        );
      } finally {
        revokeCronCreatorAuthorityRunScope(scope);
      }
    });
  },
);
