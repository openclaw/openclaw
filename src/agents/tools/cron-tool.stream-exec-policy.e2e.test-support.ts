import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { acquireGatewayTestClient } from "../../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.js";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.js";
import type { CronJob } from "../../cron/types.js";
import {
  readProviderBody,
  writeToolCall,
} from "../../gateway/gateway-provider-fixture.test-support.js";
import { buildMockOpenAiResponsesProvider } from "../../gateway/test-openai-responses-model.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import type { AgentWaitResult } from "../run-wait.types.js";
import { AUTOMATIONS_TOOL_NAME } from "./automations-tool-name.js";

export async function createHostStreamApprovalProvider() {
  let pendingJob: Record<string, unknown> | undefined;
  const fixture = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const body: unknown = JSON.parse(await readProviderBody(request));
          if (pendingJob) {
            if (
              !isRecord(body) ||
              !Array.isArray(body.tools) ||
              !body.tools.some((tool) => isRecord(tool) && tool.name === AUTOMATIONS_TOOL_NAME)
            ) {
              throw new Error("The creator's model request did not expose automations");
            }
            const job = pendingJob;
            pendingJob = undefined;
            writeToolCall(response, AUTOMATIONS_TOOL_NAME, { action: "add", job });
          } else {
            writeOpenAiResponsesText(response, {
              text: "Watcher request finished.",
              messageId: randomUUID(),
              responseId: randomUUID(),
            });
          }
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      }),
  });
  return {
    model: buildMockOpenAiResponsesProvider(
      `http://127.0.0.1:${fixture.claim.port}/v1`,
      "stream-authority",
    ),
    propose(job: Record<string, unknown>) {
      expect(pendingJob).toBeUndefined();
      pendingJob = job;
    },
    async [Symbol.asyncDispose]() {
      fixture.listener.closeAllConnections();
      await fixture.releaseListener();
      await fixture.claim.release();
    },
  };
}

export async function proveHostStreamApprovalEffects(params: {
  instance: OpenClawTestInstance;
  provider: Awaited<ReturnType<typeof createHostStreamApprovalProvider>>;
  waitForPid: (pathname: string) => Promise<number>;
  waitForDead: (pid: number) => Promise<void>;
}) {
  const { instance, provider } = params;
  let approvalRequests = 0;
  let expectedSession: string | undefined;
  let requested = createDeferredCore<{ id: string; request: Record<string, unknown> }>();
  const client = await acquireGatewayTestClient(
    {
      url: instance.url,
      token: instance.gatewayToken,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      origin: "http://localhost",
      scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals"],
      caps: ["approvals"],
      onEvent: (event) => {
        if (event.event !== "exec.approval.requested" || !isRecord(event.payload)) {
          return;
        }
        const { id, request } = event.payload;
        if (typeof id === "string" && isRecord(request) && request.sessionKey === expectedSession) {
          approvalRequests += 1;
          requested.resolve({ id, request });
        }
      },
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: "Host approval observer did not connect",
      closeMessage: "Host approval observer closed before connecting",
    },
  );
  const jobs = async () =>
    (
      await client.request<{ jobs: CronJob[] }>("cron.list", {
        includeDisabled: true,
      })
    ).jobs;
  const absentMarkers: string[] = [];
  const sessions: string[] = [];
  const turns: Promise<unknown>[] = [];
  await runQaGatewayFixture(
    async () => {
      for (const decision of ["allow-once", "deny", "revoke"] as const) {
        const name = `Host ask-always ${decision}`;
        const pidPath = path.join(instance.state.workspaceDir, `ask-always-${decision}.pid`);
        const source = [
          `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
        ].join("");
        const created = await client.request<{ key: string }>("sessions.create", {
          agentId: "main",
          label: name,
        });
        sessions.push(created.key);
        expectedSession = created.key;
        requested = createDeferredCore();
        approvalRequests = 0;
        provider.propose({
          name,
          schedule: {
            kind: "stream",
            command: [process.execPath, "-e", source],
            cwd: instance.state.workspaceDir,
          },
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "Handle synthetic events" },
          delivery: { mode: "none" },
        });
        const before = await jobs();
        const runId = randomUUID();
        await client.request("chat.send", {
          sessionKey: created.key,
          message: `/exec ask=always Create the ${name} watcher.`,
          idempotencyKey: runId,
        });
        const terminal = client.request<AgentWaitResult>(
          "agent.wait",
          {
            runId,
            timeoutMs: 30_000,
          },
          { timeoutMs: 35_000 },
        );
        turns.push(terminal);
        void terminal.catch(() => {});
        const approval = await Promise.race([
          requested.promise,
          terminal.then((result) => {
            throw new Error(
              `${name}: creator settled before asking for approval: ${JSON.stringify(result)}
${instance.logs()}`,
            );
          }),
        ]);
        expect(approval.request).toMatchObject({
          host: "gateway",
          ask: "always",
          sessionKey: created.key,
          streamProposal: { name, operation: "add" },
        });
        expect(await jobs()).toEqual(before);
        await expect(fs.readFile(pidPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        if (decision === "revoke") {
          await client.request("sessions.patch", { key: created.key, permissionMode: "read-only" });
          await expect(
            client.request("exec.approval.resolve", {
              id: approval.id,
              decision: "allow-once",
            }),
          ).rejects.toThrow();
        } else {
          await client.request("exec.approval.resolve", { id: approval.id, decision });
        }
        const settled = await terminal;
        const failureContext =
          settled.status === "pending" || settled.status === "timeout"
            ? `${name}: creator did not settle
${instance.logs()}`
            : name;
        expect(settled.status, failureContext).not.toBe("pending");
        expect(settled.status, failureContext).not.toBe("timeout");
        expect(approvalRequests).toBe(1);
        if (decision === "allow-once") {
          expect(settled.status).toBe("ok");
          const saved = (await jobs()).find((job) => job.name === name);
          expect(saved).toBeDefined();
          if (!saved) {
            throw new Error("Approved watcher was not saved");
          }
          const pid = await params.waitForPid(pidPath);
          expect(await client.request("cron.get", { id: saved.id })).toMatchObject({
            enabled: true,
            streamExecutionHost: "gateway",
            state: { streamStatus: "running" },
          });
          await client.request("cron.remove", { id: saved.id });
          await params.waitForDead(pid);
        } else {
          expect(await jobs()).toEqual(before);
          absentMarkers.push(pidPath);
        }
      }
      for (const marker of absentMarkers) {
        await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    async () => {
      for (const key of sessions) {
        await client.request("sessions.delete", { key });
      }
    },
    () => client.stopAndWait({ timeoutMs: 1_000 }),
    async () => {
      await Promise.allSettled(turns);
    },
  );
}
