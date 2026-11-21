import { randomUUID } from "node:crypto";
import { assert, expect, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { readAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import * as cronCreator from "../agents/cron-creator-authority-context.js";
import * as attemptTools from "../agents/embedded-agent-runner/run/attempt-tool-prepare.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as cronRun from "../cron/run-admission.js";
import type { CronStandingGrantAuthority } from "../cron/standing-grant-authority.types.js";
import type { CronStoredJob } from "../cron/types.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { removePairedDevice } from "../infra/device-pairing.js";
import { createAgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import {
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "./cron-creator-authority-grant.js";
import type { CronCreatorAuthorityRunScope } from "./cron-creator-authority-grant.types.js";
import { WRITER } from "./operator-admission.contracts.test-support.js";
import { prepareAdmissionOperator } from "./operator-admission.credentials.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
} from "./server-plugin-runtime-client.js";

type Scenario = "before-start" | "after-start" | "stop";

export async function runCronAdmissionCase(
  kind: "cron-standing-grant" | "cron-management-grant" | "cron-operator-source",
  scenario: Scenario,
  fixture: AdmissionFixture,
) {
  const c = fixture.current;
  assert(c && fixture.kernel);
  const context = fixture.kernel.gatewayRequestContext;
  const operator = await prepareAdmissionOperator(fixture, c, {
    credential: "token",
    scopes: kind === "cron-operator-source" ? WRITER : ["operator.admin"],
    ingress: "control-ui",
  });
  const self = await operator.request<{ profile: { id: string } }>("users.self", {});
  await fixture.setSessionOwner(self.profile.id);
  const admin = await fixture.admin(c.signal);
  const creatorSessionKey = `${c.sessionKey}:creator`;
  let creatorScope: CronCreatorAuthorityRunScope | undefined;
  let standingAuthority: CronStandingGrantAuthority | undefined;
  let job: CronStoredJob | undefined;
  let jobRemoved = false;
  let creatorRunId: string | undefined;
  let creatorTool: AnyAgentTool | undefined;
  let occurrence: { runId: string; sessionKey: string } | undefined;
  const previousToolPreparation = vi.isMockFunction(attemptTools.prepareEmbeddedAttemptToolBase)
    ? vi.mocked(attemptTools.prepareEmbeddedAttemptToolBase).getMockImplementation()
    : undefined;
  const prepareTools = previousToolPreparation ?? attemptTools.prepareEmbeddedAttemptToolBase;
  const toolObserver = vi
    .spyOn(attemptTools, "prepareEmbeddedAttemptToolBase")
    .mockImplementation(async (params) => {
      const tools = await prepareTools(params);
      const isOccurrence = Boolean(job && params.attempt.prompt.includes(c.queuedText));
      if (isOccurrence) {
        assert(params.attempt.sessionKey);
        occurrence = { runId: params.attempt.runId, sessionKey: params.attempt.sessionKey };
      }
      if (
        kind === "cron-operator-source" &&
        (isOccurrence || (!job && params.attempt.sessionKey === c.sessionKey))
      ) {
        const authority = readAdmittedRunOperatorAuthority(params.attempt.admittedRunContext);
        assert(authority, "The real creator and scheduled tool runs must carry operator authority");
        expect([...authority.scopes].toSorted()).toEqual([...WRITER].toSorted());
        if (isOccurrence) {
          expect(params.attempt.runId).not.toBe(creatorRunId);
          expect(authority.requesterOwner).toBe(true);
        } else {
          const tool = tools.toolsRaw.find((candidate) => candidate.name === AUTOMATIONS_TOOL_NAME);
          assert(params.attempt.admittedRunContext);
          creatorTool = tool
            ? wrapToolWithGatewayCallerIdentity(
                tool,
                createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: params.attempt.admittedRunContext,
                  agentId: params.setup.sessionAgentId,
                  sessionKey: c.sessionKey,
                  approvalSignals: [tools.toolAbortSignal],
                }),
              )
            : undefined;
        }
      }
      return tools;
    });
  const create = cronCreator.createCronCreatorAuthorityCapability;
  const creatorObserver = vi
    .spyOn(cronCreator, "createCronCreatorAuthorityCapability")
    .mockImplementation((...args) => {
      const capability = create(...args);
      if (capability?.managementEntitlement) {
        creatorScope = capability;
      }
      return capability;
    });
  const prepare = cronRun.prepareCronRunAdmission;
  const runObserver = vi.spyOn(cronRun, "prepareCronRunAdmission").mockImplementation((params) => {
    const admitted = prepare(params);
    if (params.jobId === job?.id) {
      standingAuthority = admitted.standingGrantAuthority;
    }
    return admitted;
  });
  const unsubscribe = onAgentEvent((event) => {
    if (event.runId !== occurrence?.runId || event.stream !== "lifecycle") {
      return;
    }
    if (event.data.phase === "end" || event.data.phase === "error") {
      c.terminal(event.runId).resolve(
        event.data.aborted ? "aborted" : event.data.phase === "error" ? "error" : "final",
      );
    }
  });
  try {
    const definition = {
      name: `live admission ${c.id}`,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: `session:${c.sessionKey}`,
      sessionKey: c.sessionKey,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: c.queuedText },
      delivery: { mode: "none" },
    };
    let createdId: string;
    if (kind === "cron-operator-source") {
      const creator = await operator.request<{ runId: string }>("chat.send", {
        sessionKey: c.sessionKey,
        message: "hold parent-bound automation creator",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      creatorRunId = creator.runId;
      await c.wait(
        awaitGateBeforeSettlement(
          c.firstReached.promise,
          c.terminal(creator.runId).promise,
          "Creator settled before preparing its real automation tool",
        ),
      );
      assert(creatorTool, "The actual admitted parent run must expose its bound automation tool");
      await creatorTool.execute(`${c.id}:plan`, {
        action: "plan",
        names: [definition.name],
      });
      const added = await creatorTool.execute(c.id, {
        action: "add",
        job: { ...definition, sessionTarget: "current" },
      });
      assert(
        added.details &&
          typeof added.details === "object" &&
          "id" in added.details &&
          typeof added.details.id === "string",
        "The real automation tool must return its persisted job",
      );
      createdId = added.details.id;
    } else {
      createdId = (await operator.request<{ id: string }>("cron.add", definition)).id;
    }
    job = await context.cron.readJob(createdId);
    assert(job, "cron.add must persist its actual job");
    if (kind === "cron-operator-source") {
      assert(job.operatorSource, "The real parent tool must retain its operator source");
      expect(job.operatorSource.source.kind).not.toBe("gateway");
      expect(job.operatorSource.source).toMatchObject({
        sessionKey: c.sessionKey,
        sourceRunId: creatorRunId,
        snapshot: { scopes: WRITER },
      });
      expect(job.owner?.sessionKey).toBe(c.sessionKey);
      expect(job.scheduledToolPolicy).toMatchObject({
        mode: "account",
        ownerSessionKey: c.sessionKey,
      });
      c.releaseFirst.resolve();
      assert(creatorRunId);
      expect(await c.wait(c.terminal(creatorRunId).promise)).toBe("final");
    }
    let run: { runId: string };
    if (kind === "cron-management-grant") {
      const creator = await operator.request<{ runId: string }>("chat.send", {
        sessionKey: creatorSessionKey,
        message: "hold creator capability",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      await c.wait(c.firstReached.promise);
      assert(
        creatorScope?.managementEntitlement,
        "A real Control UI turn must issue its management capability",
      );
      expect(creatorScope.runId).toBe(creator.runId);
      const delegated = getAgentRunContext(creator.runId)?.delegatedAuthority;
      assert(delegated, "Management must use the creator's actual admitted execution");
      const grant = mintCronCreatorAuthorityGrant(creatorScope, undefined, undefined, {
        method: "cron.run",
        authority: delegated,
      });
      const identity = await createAgentRuntimeIdentity({
        agentId: "main",
        sessionKey: creatorSessionKey,
        operationalRunInstance: delegated.operationalRunInstance,
        approvalAuthority: delegated,
        cronManagementGrant: grant,
      });
      assert(identity);
      const client = mergePluginRuntimeClientInternal(
        createSyntheticPluginRuntimeClient({ scopes: [] }),
        { agentRuntimeIdentity: identity },
      );
      if (scenario === "before-start") {
        revokeCronCreatorAuthorityRunScope(creatorScope);
        await expect(
          dispatchGatewayRequestInProcess(
            "cron.run",
            { id: job.id, mode: "force" },
            { client, context },
          ),
        ).rejects.toThrow("missing scope:");
        expect((await context.cron.readJob(job.id))?.payload).toEqual(job.payload);
        expect(c.queuedCalls).toBe(0);
        return;
      }
      run = await dispatchGatewayRequestInProcess<{ runId: string }>(
        "cron.run",
        { id: job.id, mode: "force" },
        { client, context },
      );
    } else {
      if (scenario === "before-start" && kind === "cron-operator-source") {
        await removePairedDevice(c.identity.deviceId);
      }
      run = await admin.request<{ runId: string }>("cron.run", { id: job.id, mode: "force" });
    }
    const finished = context.cron.waitForManualRun(run.runId, 30_000, c.signal);
    if (scenario === "before-start" && kind === "cron-operator-source") {
      expect(await c.wait(finished)).toBe(true);
      const history = await admin.request<{
        entries: Array<{ status: string; error?: string; summary?: string }>;
      }>("cron.runs", { id: job.id, runId: run.runId, limit: 1 });
      expect(history.entries).toHaveLength(1);
      const entry = history.entries[0];
      assert(entry);
      expect(entry).toMatchObject({ status: "error" });
      expect(`${entry.error ?? ""} ${entry.summary ?? ""}`).toMatch(
        /operator|authority|revok|grant/i,
      );
      expect((await context.cron.readJob(job.id))?.payload).toEqual(job.payload);
      expect(c.queuedCalls).toBe(0);
      return;
    }
    await c.wait(
      awaitGateBeforeSettlement(
        c.recoveredReached.promise,
        finished,
        "Cron occurrence settled before reaching the provider",
      ),
    );
    assert(occurrence, "The scheduled occurrence must prepare its real tools");
    const running = occurrence.runId;
    if (kind === "cron-standing-grant") {
      assert(standingAuthority, "A real scheduled occurrence must own its receipt capability");
      const authority = standingAuthority;
      expect(() => authority.assertCurrent()).not.toThrow();
    }
    if (scenario === "stop") {
      expect(
        await admin.request("chat.abort", { sessionKey: occurrence.sessionKey }),
      ).toMatchObject({
        aborted: true,
      });
      expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
      c.releaseRecovered.resolve();
    } else if (scenario === "before-start") {
      // This is the receipt capability's next-use boundary, not operator
      // admission. Its in-flight guards remain in LIFETIME_CHECK_CALLS until
      // the later lifetime PR; removing a job must retire the receipt.
      await admin.request("cron.remove", { id: job.id });
      jobRemoved = true;
      assert(standingAuthority);
      const authority = standingAuthority;
      expect(() => authority.assertCurrent()).toThrow();
      c.releaseRecovered.resolve();
    } else {
      if (kind === "cron-management-grant") {
        assert(creatorScope);
        revokeCronCreatorAuthorityRunScope(creatorScope);
      } else {
        await removePairedDevice(c.identity.deviceId);
      }
      c.releaseRecovered.resolve();
      expect(await c.wait(c.terminal(running).promise)).toBe("final");
    }
    expect(await c.wait(finished)).toBe(true);
    if (kind === "cron-standing-grant" && scenario === "stop") {
      assert(standingAuthority);
      const authority = standingAuthority;
      expect(() => authority.assertCurrent()).toThrow();
    }
    if (scenario !== "before-start") {
      const history = await admin.request<{ entries: Array<{ status: string }> }>("cron.runs", {
        id: job.id,
        runId: run.runId,
        limit: 1,
      });
      expect(history.entries).toHaveLength(1);
      if (scenario === "after-start") {
        expect(history.entries[0]).toMatchObject({ status: "ok" });
      }
    }
    expect(fixture.providerErrors).toEqual([]);
  } finally {
    c.releaseFirst.resolve();
    c.releaseRecovered.resolve();
    try {
      await admin.request("chat.abort", { sessionKey: creatorSessionKey });
    } finally {
      try {
        if (job && !jobRemoved) {
          await admin.request("cron.remove", { id: job.id });
        }
      } finally {
        unsubscribe();
        creatorObserver.mockRestore();
        runObserver.mockRestore();
        if (previousToolPreparation) {
          toolObserver.mockImplementation(previousToolPreparation);
        } else {
          toolObserver.mockRestore();
        }
      }
    }
  }
}
