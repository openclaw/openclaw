import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as logger from "../../logger.js";
import { bumpGatewayAccessRevision } from "../gateway-access-revision.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import {
  approvedStreamJob,
  expectIndependentExecApproval,
  withStreamApprovalFixture,
} from "./cron-stream-approval.integration.test-support.js";
import {
  SESSION,
  SESSION_ID,
  CREATOR,
  stateDir,
  cron,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";

// mock-isolation: The approval boundary uses Gateway exec without attached-node inventory.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));
// mock-isolation: Approval tests use captured sandbox facts without contacting a real Docker daemon.
vi.mock("../../agents/sandbox/docker-persistent-target.js", () => ({
  assertDockerPersistentTargetCurrent: async () => ({ id: "docker" }),
  readDockerPersistentContainer: async () => ({
    kind: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  }),
}));

installRequesterCronAuthorityTestHooks();

describe("agent stream approval through the automation tool", () => {
  it.each(["shape", "past schedule"] as const)(
    "allows correction after a server %s rejection, then honors actual denial",
    async (invalid) => {
      await withStreamApprovalFixture(async ({ tools, read, deliveries, takeApproval, decide }) => {
        const job =
          invalid === "shape"
            ? { schedule: { kind: "stream", command: "tail -F example.log" }, task: "watch" }
            : {
                ...approvedStreamJob(),
                schedule: { kind: "at", at: "2000-01-01T00:00:00.000Z" },
              };
        await expect(tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job })).rejects.toThrow(
          invalid === "shape" ? /invalid cron.add params/ : /past/,
        );
        expect(deliveries).toEqual([]);
        expect(await read()).toEqual([]);
        const corrected = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: approvedStreamJob(),
        });
        const request = await takeApproval(corrected);
        await decide(request.id, "deny");
        expect(await corrected).toMatchObject({ details: { outcome: "operator-denied" } });
        expect(await read()).toEqual([]);
      });
    },
  );

  it("allows a corrected disable after server validation rejection", async () => {
    await withStreamApprovalFixture(
      async ({ tools, read }) => {
        await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: approvedStreamJob() });
        const original = expectDefined((await read())[0], "saved watcher");
        await expect(
          tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "update",
            jobId: original.id,
            job: { enabled: false, schedule: { kind: "at", at: "2000-01-01T00:00:00.000Z" } },
          }),
        ).rejects.toThrow(/past/);
        expect((await read())[0]).toMatchObject({ id: original.id, enabled: true });
        await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "update",
          jobId: original.id,
          job: { enabled: false },
        });
        expect((await read())[0]).toMatchObject({ id: original.id, enabled: false });
      },
      { ask: "off" },
    );
  });

  it.each([false, true])(
    "removes only the captured watcher without another question (definition changed=%s)",
    async (changed) => {
      await withStreamApprovalFixture(
        async ({ tools, read }) => {
          await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: approvedStreamJob() });
          const original = expectDefined((await read())[0], "saved watcher");
          const remove = cron.remove.bind(cron);
          const mutation = vi.spyOn(cron, "remove").mockImplementationOnce(async (...args) => {
            if (changed) {
              await cron.update(original.id, { name: "Changed during preparation" });
            }
            return await remove(...args);
          });
          try {
            const removal = tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "remove",
              jobId: original.id,
            });
            if (changed) {
              // Native commit checks reject a definition changed after it was captured.
              await expect(removal).rejects.toMatchObject({
                code: "INVALID_REQUEST",
                details: { code: "CRON_JOB_CHANGED" },
              });
              expect((await read())[0]).toMatchObject({
                id: original.id,
                name: "Changed during preparation",
              });
            } else {
              await expect(removal).resolves.toMatchObject({ details: { removed: true } });
              expect(await read()).toEqual([]);
            }
            expect(mutation).toHaveBeenCalledOnce();
          } finally {
            mutation.mockRestore();
          }
        },
        { ask: "off" },
      );
    },
  );

  it("diagnoses an approved ordinary exec whose waiting authority changed without executing it", async () => {
    const warnings = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    try {
      await withStreamApprovalFixture(async ({ tools, manager, takeApproval, decide }) => {
        const marker = path.join(stateDir, "denied-command-ran");
        const script = path.join(stateDir, "ordinary-approval.cjs");
        await writeFile(script, 'require("node:fs").writeFileSync(process.argv[2], "executed");');
        const waiting = createDeferred();
        const awaitDecision = manager.awaitDecision.bind(manager);
        const observedWait = vi.spyOn(manager, "awaitDecision").mockImplementation((id) => {
          const decision = awaitDecision(id);
          waiting.resolve();
          return decision;
        });
        try {
          const operation = tools.invoke("exec", {
            command: `"${process.execPath}" "${script}" "${marker}"`,
          });
          const request = await takeApproval(operation);
          await waiting.promise;
          bumpGatewayAccessRevision();
          await decide(request.id, "allow-once");
          const result = await operation;
          expect(result).toMatchObject({ details: { status: "failed" } });
          expect(JSON.stringify(result)).toContain("approval-request-failed");
          expect(manager.getLocalSnapshot(request.id)?.decision).toBe("allow-once");
          await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
          expect(warnings).toHaveBeenCalledWith(
            `exec approval wait failed (id=${request.id}, reason=authority-changed)`,
          );
          expect(JSON.stringify(warnings.mock.calls)).not.toContain(marker);
        } finally {
          observedWait.mockRestore();
        }
      });
    } finally {
      warnings.mockRestore();
    }
  });

  it.each(["allow-once", "deny"] as const)(
    "carries the admitted sandbox through %s without creating a host stream",
    async (decision) => {
      await withStreamApprovalFixture(
        async ({ tools, read, takeApproval, decide, runSandboxShell }) => {
          const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "add",
            job: {
              ...approvedStreamJob(),
              schedule: { kind: "stream", command: ["python3", "watch.py"], cwd: "/workspace" },
            },
          });
          const request = await takeApproval(create);
          expect(request.request).toMatchObject({
            host: "sandbox",
            cwd: "/workspace",
            commandArgv: ["python3", "watch.py"],
          });
          expect(request.request.warningText).toContain("fresh Docker container");
          expect(await read()).toEqual([]);
          await decide(request.id, decision);
          expect(runSandboxShell).not.toHaveBeenCalled();
          if (decision === "deny") {
            expect(await create).toMatchObject({
              details: {
                code: "CRON_STREAM_APPROVAL_ENDED",
                saved: false,
                action: "add",
                approvalId: request.id,
                outcome: "operator-denied",
              },
            });
            expect(await read()).toEqual([]);
          } else {
            expect(await create).toMatchObject({
              details: {
                streamExecutionHost: "sandbox",
                streamExecutionApproval: {
                  approvalId: request.id,
                  decision: "allow-once",
                  source: "operator",
                  message: expect.stringMatching(
                    /human operator approved[\s\S]*identity is not supplied/i,
                  ),
                },
              },
            });
            expect(await read()).toMatchObject([
              {
                schedule: { kind: "stream" },
                streamSandbox: {
                  backendId: "docker",
                  sessionKey: SESSION,
                  configLabel: "fixture-config",
                  containerWorkdir: "/workspace",
                },
              },
            ]);
          }
        },
        { sandbox: true },
      );
    },
  );

  it("rejects sandbox image tag replacement while the user considers the question", async () => {
    await withStreamApprovalFixture(
      async ({ tools, read, takeApproval, decide, changeSandboxImage, runSandboxShell }) => {
        const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: {
            ...approvedStreamJob(),
            schedule: { kind: "stream", command: ["python3", "watch.py"], cwd: "/workspace" },
          },
        });
        const outcome = create.then(
          () => true,
          () => false,
        );
        const request = await takeApproval(create);
        changeSandboxImage();
        await decide(request.id, "allow-once");
        expect(await outcome).toBe(false);
        expect(await read()).toEqual([]);
        expect(runSandboxShell).not.toHaveBeenCalled();
      },
      { sandbox: true },
    );
  });

  it("creates only after consent and asks again when the creator reactivates or changes its watcher", async () => {
    await withStreamApprovalFixture(
      async ({ tools, read, manager, takeApproval, decide, deliveries }) => {
        const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: { ...approvedStreamJob(), declarationKey: "fixture:approved-stream" },
        });
        const request = await takeApproval(create);
        expect(request.request).toMatchObject({
          host: "gateway",
          sessionKey: SESSION,
          sessionId: SESSION_ID,
          allowedDecisions: ["allow-once", "deny"],
          streamProposal: { name: "App log watcher", operation: "add" },
        });
        const durableApproval = await getOperatorApprovalDetailed({ id: request.id });
        expect(durableApproval).toMatchObject({
          outcome: "found",
          record: {
            source: { agentId: "main", sessionKey: SESSION, sessionId: SESSION_ID },
            presentation: { streamProposal: request.request.streamProposal },
          },
        });
        expect(request.request.command).toContain(process.execPath);
        expect(request.request.warningText).toMatch(/restart/i);
        expect(request.request.warningText).toMatch(/disabled|deleted/i);
        expect(await read()).toEqual([]);
        const concurrentCreate = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: { ...approvedStreamJob(), declarationKey: "fixture:approved-stream" },
        });
        const concurrentRequest = await takeApproval(concurrentCreate);
        await decide(request.id, "allow-once");
        const created = await create;
        await decide(concurrentRequest.id, "allow-once");
        const unchanged = await concurrentCreate;
        expect(created).toMatchObject({
          details: {
            created: true,
            job: { streamExecutionHost: "gateway" },
            streamExecutionApproval: {
              approvalId: request.id,
              decision: "allow-once",
              source: "operator",
              message: expect.stringMatching(
                /human operator approved[\s\S]*identity is not supplied/i,
              ),
            },
          },
        });
        expect(unchanged).toMatchObject({ details: { created: false, updated: false } });
        expect(unchanged).not.toHaveProperty("details.streamExecutionApproval");
        expect(manager.getLocalSnapshot(concurrentRequest.id)?.consumedDecision).toBeUndefined();
        const stored = expectDefined((await read())[0], "approved stream");
        expect(request.request.warningText).toContain(`Watcher ID: ${JSON.stringify(stored.id)}.`);
        expect(stored).toMatchObject({
          enabled: true,
          schedule: approvedStreamJob().schedule,
          scheduledToolPolicy: { mode: "account", ownerSessionKey: SESSION },
        });
        expect(await manager.consumeAllowOnce(request.id)).toBe(false);
        expect(stored).not.toHaveProperty("streamExecutionApproval");
        for (const action of ["list", "get"] as const) {
          const result = await tools.invoke(AUTOMATIONS_TOOL_NAME, { action, jobId: stored.id });
          expect(JSON.stringify(result)).toContain(stored.id);
          expect(result).not.toHaveProperty("details.streamExecutionApproval");
          expect(result).toMatchObject({
            details:
              action === "get"
                ? { streamExecutionHost: "gateway" }
                : {
                    jobs: expect.arrayContaining([
                      expect.objectContaining({ id: stored.id, streamExecutionHost: "gateway" }),
                    ]),
                  },
          });
        }
        const operatorJob = await cron.add({
          name: "Private operator watcher",
          enabled: true,
          schedule: approvedStreamJob().schedule,
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "Operator-only stream" },
        });
        const listed = await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "list" });
        expect(JSON.stringify(listed)).toContain(stored.id);
        expect(JSON.stringify(listed)).not.toContain(operatorJob.id);
        await expect(
          tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "get", jobId: operatorJob.id }),
        ).rejects.toThrow(/not found/);
        const disabled = await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "update",
          jobId: stored.id,
          job: { name: "Renamed log watcher", enabled: false },
        });
        expect(disabled).not.toHaveProperty("details.streamExecutionApproval");
        expect((await read())[0]).toMatchObject({ name: "Renamed log watcher", enabled: false });
        expect(deliveries).toHaveLength(2);
        for (const patch of [
          { enabled: true },
          { state: { streamRestartExhausted: false } },
          {
            schedule: { ...approvedStreamJob().schedule, command: [process.execPath, "--version"] },
          },
        ]) {
          const before = await read();
          const update = tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "update",
            jobId: stored.id,
            job: patch,
          });
          const next = await takeApproval(update);
          expect(next.id).not.toBe(request.id);
          expect(next.request.sessionId).toBe(SESSION_ID);
          expect(next.request.warningText).toContain(`Watcher ID: ${JSON.stringify(stored.id)}.`);
          expect(await getOperatorApprovalDetailed({ id: next.id })).toMatchObject({
            outcome: "found",
            record: { source: { agentId: "main", sessionKey: SESSION, sessionId: SESSION_ID } },
          });
          expect(await read()).toEqual(before);
          await decide(next.id, "allow-once");
          expect(await update).toMatchObject({
            details: {
              id: stored.id,
              streamExecutionApproval: {
                approvalId: next.id,
                decision: "allow-once",
                source: "operator",
                message: expect.stringMatching(
                  /human operator approved[\s\S]*identity is not supplied/i,
                ),
              },
            },
          });
          expect(await manager.consumeAllowOnce(next.id)).toBe(false);
        }
        expect((await read())[0]).toMatchObject({
          enabled: true,
          schedule: { command: [process.execPath, "--version"] },
        });
        await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "update",
          jobId: stored.id,
          job: { enabled: false },
        });
        const beforeDeniedActivation = await read();
        const deniedActivation = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "update",
          jobId: stored.id,
          job: { enabled: true },
        });
        const declined = await takeApproval(deniedActivation);
        await decide(declined.id, "deny");
        expect(await deniedActivation).toMatchObject({
          details: {
            saved: false,
            action: "update",
            approvalId: declined.id,
            outcome: "operator-denied",
            message: expect.stringContaining("existing watcher unchanged"),
          },
        });
        expect(await read()).toEqual(beforeDeniedActivation);
        const nextActivation = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "update",
          jobId: stored.id,
          job: { enabled: true },
        });
        const nextRequest = await takeApproval(nextActivation);
        expect(nextRequest.id).not.toBe(declined.id);
        await decide(nextRequest.id, "deny");
        expect(await nextActivation).toMatchObject({ details: { saved: false } });
        expect(await read()).toEqual(beforeDeniedActivation);
        expect(deliveries).toHaveLength(7);
      },
    );
  });

  it.each(["reactivate", "replace source"] as const)(
    "commits one approved %s from a Control UI management turn",
    async (change) => {
      await withStreamApprovalFixture(
        async ({ tools, read, takeApproval, decide, setPolicy, deliveries }) => {
          await tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: approvedStreamJob() });
          const stored = expectDefined((await read())[0], "unattended stream");
          if (change === "reactivate") {
            await tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "update",
              jobId: stored.id,
              job: { enabled: false },
            });
          }
          await setPolicy("full", "always");
          const patch =
            change === "reactivate"
              ? { enabled: true }
              : {
                  schedule: {
                    ...approvedStreamJob().schedule,
                    command: [process.execPath, "--version"],
                  },
                };
          const update = tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "update",
            jobId: stored.id,
            job: patch,
          });
          const request = await takeApproval(update);
          await decide(request.id, "allow-once");
          const outcome = await Promise.race([
            update.then((result) => ({ kind: "committed" as const, result })),
            takeApproval(update).then((repeated) => ({ kind: "repeated" as const, repeated })),
          ]);
          if (outcome.kind === "repeated") {
            await decide(outcome.repeated.id, "deny");
            await update;
          }
          expect(outcome.kind).toBe("committed");
          expect(deliveries).toHaveLength(1);
          expect((await read())[0]).toMatchObject({ id: stored.id, ...patch });
        },
        { ask: "off", turnSourceChannel: "webchat", controlUiAdmin: true },
      );
    },
  );

  it.each(["deny", "expire", "cancel", "revoke", "auto-review"] as const)(
    "leaves no stream when the pending request ends with %s",
    async (outcome) => {
      await withStreamApprovalFixture(
        async ({ tools, read, manager, takeApproval, decide, revokeRun }) => {
          const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "add",
            job: approvedStreamJob(),
          });
          const settled = create.then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          );
          const request = await takeApproval(create);
          expect(await read()).toEqual([]);
          if (outcome === "deny") {
            await decide(request.id, "deny");
          } else if (outcome === "expire") {
            await manager.expire(request.id);
          } else if (outcome === "cancel") {
            await manager.forceDenyDetailed(
              request.id,
              "run-aborted",
              { kind: "system", id: null },
              "cancelled",
            );
          } else if (outcome === "auto-review") {
            expect(await manager.resolveAutoReview(request.id)).toBe(true);
          } else {
            revokeRun();
            await expect(decide(request.id, "allow-once")).rejects.toThrow();
          }
          if (outcome === "deny" || outcome === "expire" || outcome === "cancel") {
            expect((await settled).ok).toBe(true);
            expect(await create).toMatchObject({
              details: {
                code: "CRON_STREAM_APPROVAL_ENDED",
                saved: false,
                action: "add",
                approvalId: request.id,
                outcome:
                  outcome === "deny"
                    ? "operator-denied"
                    : outcome === "expire"
                      ? "expired"
                      : "cancelled",
              },
            });
          } else {
            expect((await settled).ok).toBe(false);
            await expect(create).rejects.not.toThrow(/operator declined/i);
          }
          expect(await read()).toEqual([]);
          if (outcome === "deny") {
            await expectIndependentExecApproval({ tools, takeApproval, decide });
          }
          if (outcome !== "revoke") {
            await expect(
              tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "status" }),
            ).resolves.toBeDefined();
          }
          if (outcome === "auto-review") {
            await expect(decide(request.id, "allow-once")).resolves.toEqual({ ok: true });
            expect(manager.getLocalSnapshot(request.id)?.resolutionSource).toBe("auto-review");
          } else {
            expect(await manager.consumeAllowOnce(request.id)).toBe(false);
            await expect(decide(request.id, "allow-once")).rejects.toThrow();
          }
          expect(await read()).toEqual([]);
        },
      );
    },
  );

  it("does not claim user approval for unattended creation or updates", async () => {
    await withStreamApprovalFixture(
      async ({ tools, read, deliveries }) => {
        const created = await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: approvedStreamJob(),
        });
        expect(created).not.toHaveProperty("details.streamExecutionApproval");
        const stored = expectDefined((await read())[0], "unattended stream");
        const updated = await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "update",
          jobId: stored.id,
          job: {
            schedule: { ...approvedStreamJob().schedule, command: [process.execPath, "--version"] },
          },
        });
        expect(updated).not.toHaveProperty("details.streamExecutionApproval");
        expect(deliveries).toEqual([]);
      },
      { ask: "off" },
    );
  });

  it("requires a delivered question even when the host fallback permits execution", async () => {
    await withStreamApprovalFixture(
      async ({ tools, read, deliveries }) => {
        await expect(
          tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job: approvedStreamJob() }),
        ).rejects.toThrow(/approval|deliver/i);
        expect(deliveries).toHaveLength(1);
        expect(await read()).toEqual([]);
      },
      { deliveryAvailable: false },
    );
  });

  it("refuses a script changed after the user was shown the pending watcher", async () => {
    const scriptPath = path.join(stateDir, "stream-source.js");
    await writeFile(scriptPath, 'console.log("reviewed source");\n');
    await withStreamApprovalFixture(async ({ tools, read, takeApproval, decide }) => {
      const job = approvedStreamJob();
      const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
        action: "add",
        job: { ...job, schedule: { ...job.schedule, command: [process.execPath, scriptPath] } },
      });
      const settled = create.then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      const request = await takeApproval(create);
      expect(request.request.command).toContain(scriptPath);
      await writeFile(scriptPath, 'console.log("unreviewed replacement");\n');
      await decide(request.id, "allow-once");
      expect(await settled).toMatchObject({
        ok: false,
        error: expect.objectContaining({ message: expect.stringMatching(/SYSTEM_RUN_DENIED/) }),
      });
      expect(await read()).toEqual([]);
    });
  });

  it("asks again when the reviewed policy changes before the approval is used", async () => {
    await withStreamApprovalFixture(async ({ tools, read, takeApproval, decide, setPolicy }) => {
      const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
        action: "add",
        job: approvedStreamJob(),
      });
      const first = await takeApproval(create);
      await setPolicy("full", "always");
      await decide(first.id, "allow-once");
      const second = await takeApproval(create);
      expect(second.id).not.toBe(first.id);
      expect(await read()).toEqual([]);
      await decide(second.id, "allow-once");
      expect(await create).toMatchObject({
        details: {
          streamExecutionApproval: {
            approvalId: second.id,
            decision: "allow-once",
            source: "operator",
            message: expect.stringMatching(
              /human operator approved[\s\S]*identity is not supplied/i,
            ),
          },
        },
      });
      expect(await read()).toMatchObject([{ name: "App log watcher", enabled: true }]);
    });
  });

  it.each([
    { change: "exec config", sandbox: false },
    { change: "tool policy", sandbox: false },
    { change: "session permission", sandbox: false },
    { change: "session permission update", sandbox: false },
    { change: "sandbox config", sandbox: true },
    { change: "sandbox workspace", sandbox: true },
    { change: "session sandbox", sandbox: true },
    { change: "inherited tool policy", sandbox: true },
    { change: "unrelated config", sandbox: true },
  ] as const)(
    "rechecks $change after a delivered approval question",
    async ({ change, sandbox }) => {
      await withStreamApprovalFixture(
        async ({ tools, read, takeApproval, decide, setConfig }) => {
          const job = {
            ...approvedStreamJob(),
            ...(sandbox
              ? {
                  schedule: { kind: "stream", command: ["python3", "watch.py"], cwd: "/workspace" },
                }
              : {}),
          };
          let savedId: string | undefined;
          if (change === "session permission update") {
            const initial = tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "add", job });
            const initialRequest = await takeApproval(initial);
            await decide(initialRequest.id, "allow-once");
            await initial;
            savedId = expectDefined((await read())[0], "created stream").id;
            await tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "update",
              jobId: savedId,
              job: { enabled: false },
            });
          }
          const before = await read();
          const mutation = tools.invoke(
            AUTOMATIONS_TOOL_NAME,
            savedId
              ? { action: "update", jobId: savedId, job: { enabled: true } }
              : { action: "add", job },
          );
          const outcome = mutation.then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          const request = await takeApproval(mutation);
          expect(await read()).toEqual(before);
          if (change === "exec config") {
            setConfig((current) => ({
              ...current,
              tools: { ...current.tools, exec: { ...current.tools?.exec, security: "deny" } },
            }));
          } else if (change === "tool policy") {
            setConfig((current) => ({
              ...current,
              tools: { ...current.tools, allow: [AUTOMATIONS_TOOL_NAME] },
            }));
          } else if (change === "sandbox config") {
            setConfig((current) => ({
              ...current,
              agents: {
                ...current.agents,
                defaults: { ...current.agents?.defaults, sandbox: { mode: "off" } },
              },
            }));
          } else if (change === "sandbox workspace") {
            setConfig((current) => ({
              ...current,
              agents: {
                ...current.agents,
                defaults: {
                  ...current.agents?.defaults,
                  workspace: path.join(stateDir, "changed-workspace"),
                },
              },
            }));
          } else if (change === "unrelated config") {
            setConfig((current) => ({ ...current, gateway: { ...current.gateway, port: 19001 } }));
          } else {
            replaceSessionEntrySync(
              { sessionKey: SESSION },
              {
                sessionId: SESSION_ID,
                updatedAt: 1,
                lifecycleRevision: "original",
                createdActor: CREATOR,
                ...(change === "session sandbox"
                  ? { sandboxMode: "off" }
                  : change === "inherited tool policy"
                    ? { inheritedToolPolicyVersion: 1, inheritedToolDeny: ["exec"] }
                    : { permissionMode: "read-only" }),
              },
            );
          }
          // Config revocation can close the question before the operator resolver consumes it.
          await Promise.allSettled([decide(request.id, "allow-once")]);
          const settled = await outcome;
          if (change === "unrelated config") {
            if (!settled.ok) {
              throw settled.error;
            }
            expect(await read()).toMatchObject([
              { enabled: true, streamSandbox: { backendId: "docker" } },
            ]);
          } else {
            expect(settled.ok).toBe(false);
            expect(await read()).toEqual(before);
          }
        },
        { sandbox },
      );
    },
  );

  it("asks when policy tightens during validation and refuses a later hard denial", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    let hold = true;
    await withStreamApprovalFixture(
      async ({ tools, read, takeApproval, decide, setPolicy }) => {
        const create = tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: approvedStreamJob(),
        });
        const settled = create.then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        try {
          await Promise.race([
            entered.promise,
            create.then(() => {
              throw new Error("Stream mutation completed before service validation");
            }),
          ]);
          await setPolicy("full", "always");
          hold = false;
          release.resolve();
          const request = await takeApproval(create);
          expect(await read()).toEqual([]);
          await setPolicy("deny", "always");
          await decide(request.id, "allow-once");
          expect((await settled).ok).toBe(false);
          expect(await read()).toEqual([]);
        } finally {
          hold = false;
          release.resolve();
        }
      },
      {
        ask: "off",
        listConfiguredChannels: async () => {
          if (hold) {
            entered.resolve();
            await release.promise;
          }
          return [];
        },
      },
    );
  });
});
