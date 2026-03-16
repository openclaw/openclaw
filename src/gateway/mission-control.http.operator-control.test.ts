import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateRegistryCache } from "../operator-control/agent-registry.js";
import { resolveOperatorReferenceSourcePath } from "../operator-control/reference-paths.js";
import { processPendingReceipts } from "../operator-control/task-store.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createMockServerResponse } from "../test-utils/mock-http-response.js";
import { handleMissionControlHttpRequest } from "./mission-control.js";

function createRequest(params: {
  method: string;
  url: string;
  body?: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const rawBody =
    params.body === undefined
      ? undefined
      : typeof params.body === "string"
        ? params.body
        : JSON.stringify(params.body);
  const stream = Readable.from(rawBody === undefined ? [] : [rawBody]);
  const req = stream as IncomingMessage & {
    destroyed: boolean;
    destroy: () => void;
  };
  req.method = params.method;
  req.url = params.url;
  req.headers = {
    ...Object.fromEntries(
      Object.entries(params.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    ),
    ...(rawBody
      ? {
          "content-type": params.contentType ?? "application/json",
          "content-length": String(Buffer.byteLength(rawBody)),
        }
      : {}),
  };
  req.destroyed = false;
  req.destroy = () => {
    req.destroyed = true;
    return req;
  };
  return req;
}

async function requestMissionControl(params: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<{
  statusCode: number;
  body?: string;
}> {
  const req = createRequest(params);
  const res = createMockServerResponse();
  const handled = await handleMissionControlHttpRequest(req, res);
  expect(handled).toBe(true);
  return {
    statusCode: res.statusCode,
    body: res.body,
  };
}

async function seedOperatorRegistryFixture(): Promise<void> {
  const sourcePath = resolveOperatorReferenceSourcePath("agents.yaml");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(
    sourcePath,
    [
      "operator_runtime:",
      "  transports:",
      "    delegated_http:",
      "      global_default_alias: tonys-angels",
      "agents:",
      "  - id: raekwon",
      "    name: Raekwon",
      "    specialty: Backend",
      "    triggers: [backend]",
      "  - id: deb",
      "    name: Deb",
      "    specialty: Project Ops",
      "    triggers: [sprint, status, project-ops]",
      "  - id: jeffy",
      "    name: Jeffy",
      "    specialty: Kanban",
      "    triggers: [kanban, board_hygiene_packet]",
      "  - id: tonys-angels",
      "    name: Tony's Angels",
      "    specialty: Marketing",
      "    triggers: [marketing]",
      "  - id: bobby-digital",
      "    name: Bobby Digital",
      "    specialty: Engineering",
      "    triggers: [backend, engineering]",
      "teams:",
      "  - id: execution-fleet",
      "    name: Execution Fleet",
      "    lead: raekwon",
      "    route_via_lead: true",
      "    members: [raekwon]",
      "    dispatch_transport: 2tony-http",
      "  - id: project-ops",
      "    name: Project Ops",
      "    lead: deb",
      "    members: [deb, jeffy]",
      "    dispatch_transport: deb-http",
      "  - id: marketing",
      "    name: Marketing",
      "    lead: tonys-angels",
      "    route_via_lead: true",
      "    members: [tonys-angels]",
      "    dispatch_transport: delegated-http",
      "    dispatch_default_alias: tonys-angels",
      "  - id: engineering",
      "    name: Engineering",
      "    lead: bobby-digital",
      "    route_via_lead: true",
      "    members: [bobby-digital, raekwon]",
      "    dispatch_transport: delegated-http",
      "    dispatch_default_alias: bobby-digital",
      "",
    ].join("\n"),
    "utf8",
  );
  invalidateRegistryCache({ sourcePath });
}

function getFetchMockCall(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): {
  url: string;
  init: RequestInit | undefined;
} {
  const call = fetchMock.mock.calls[index];
  const input = call?.[0];
  return {
    url:
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input?.url ?? ""),
    init: call?.[1] as RequestInit | undefined,
  };
}

describe.sequential("mission-control operator control routes", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.restoreAllMocks();
    await seedOperatorRegistryFixture();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("serves task lifecycle and verified memory promotion end-to-end", async () => {
    await withStateDirEnv("openclaw-mc-operator-http-", async () => {
      const createTask = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/tasks",
        body: {
          task_id: "task-operator-1",
          idempotency_key: "idem-operator-1",
          requester: { id: "tonya", kind: "operator" },
          target: { capability: "backend", alias: "raekwon" },
          objective: "Verify operator task lifecycle",
          tier: "STANDARD",
          acceptance_criteria: ["task store contains completed task"],
          timeout_s: 900,
        },
      });
      expect(createTask.statusCode).toBe(201);
      expect(JSON.parse(String(createTask.body))).toMatchObject({
        created: true,
      });

      const createdPayload = JSON.parse(String(createTask.body)) as {
        task: { receipt: { run_id: string } };
      };

      const patchTask = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/tasks/task-operator-1/receipts",
        body: {
          schema: "2TonyTaskReceiptV1",
          task_id: "task-operator-1",
          run_id: createdPayload.task.receipt.run_id,
          state: "completed",
          owner: "2tony",
          attempt: 0,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_100,
          summary: "2Tony completed operator task",
          result_status: "SUCCESS",
          output: {
            receipt: true,
          },
        },
      });
      expect(patchTask.statusCode).toBe(200);

      const taskList = await requestMissionControl({
        method: "GET",
        url: "/mission-control/api/tasks?state=completed",
      });
      expect(taskList.statusCode).toBe(200);
      const listed = JSON.parse(String(taskList.body)) as {
        tasks: Array<{ envelope: { task_id: string } }>;
        summary: { completed: number };
      };
      expect(listed.summary.completed).toBe(1);
      expect(listed.tasks[0]?.envelope.task_id).toBe("task-operator-1");

      const serviceContext = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/memory/service-context",
        body: {
          service: "tonya",
          summary: "Tonya owns operator routing",
          content: {
            primary: true,
          },
          metadata: {
            source: "operator-http-test",
            writer: "tonya",
            evidence_ref: "task://task-operator-1",
            verified_at: 1_700_000_000_200,
          },
        },
      });
      expect(serviceContext.statusCode).toBe(201);

      const promoteOutcome = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/memory/promote",
        body: {
          collection: "task-outcomes",
          record_id: "task-operator-1-outcome",
          scope_key: "task-operator-1",
          content: {
            task_id: "task-operator-1",
            outcome: "success",
          },
          metadata: {
            source: "operator-http-test",
            writer: "northstar",
            evidence_ref: "task://task-operator-1",
            verified_at: 1_700_000_000_300,
          },
        },
      });
      expect(promoteOutcome.statusCode).toBe(201);

      const memorySnapshot = await requestMissionControl({
        method: "GET",
        url: "/mission-control/api/memory?collection=task-outcomes&limit=10",
      });
      expect(memorySnapshot.statusCode).toBe(200);
      const memory = JSON.parse(String(memorySnapshot.body)) as {
        authority: string;
        collections: { "task-outcomes": { count: number } };
        records: Array<{ scopeKey: string; collection: string }>;
      };
      expect(memory.authority).toBe("local-json-shim");
      expect(memory.collections["task-outcomes"].count).toBe(1);
      expect(memory.records[0]).toMatchObject({
        collection: "task-outcomes",
        scopeKey: "task-operator-1",
      });
    });
  });

  it("accepts delegated angela-http receipts on the shared operator callback route", async () => {
    await withStateDirEnv("openclaw-mc-operator-angela-http-", async () => {
      const createTask = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/tasks",
        body: {
          task_id: "task-operator-angela-1",
          idempotency_key: "idem-operator-angela-1",
          requester: { id: "tonya", kind: "operator" },
          target: { capability: "marketing", team_id: "marketing" },
          objective: "Verify delegated receipt lifecycle",
          tier: "STANDARD",
          acceptance_criteria: ["task store contains completed marketing task"],
          timeout_s: 900,
          execution: {
            transport: "manual",
            runtime: "acpx",
            durable: true,
          },
        },
      });
      expect(createTask.statusCode).toBe(201);

      const createdPayload = JSON.parse(String(createTask.body)) as {
        task: { receipt: { run_id: string } };
      };

      const queueTask = await requestMissionControl({
        method: "PATCH",
        url: "/mission-control/api/tasks/task-operator-angela-1",
        body: {
          state: "queued",
          owner: "tonys-angels",
        },
      });
      expect(queueTask.statusCode).toBe(200);

      const patchTask = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/tasks/task-operator-angela-1/receipts",
        body: {
          schema: "AngelaTaskReceiptV1",
          task_id: "task-operator-angela-1",
          run_id: createdPayload.task.receipt.run_id,
          state: "completed",
          attempt: 0,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_100,
          summary: "Tony's Angels completed operator task",
          result_status: "SUCCESS",
          output: {
            receipt: true,
          },
        },
      });
      expect(patchTask.statusCode).toBe(200);
      expect(JSON.parse(String(patchTask.body))).toMatchObject({
        receipt: {
          state: "completed",
          owner: "tonys-angels",
        },
      });
    });
  });

  it("queues out-of-order receipts on the shared callback route and replays them later", async () => {
    await withStateDirEnv("openclaw-mc-operator-pending-receipt-", async () => {
      const createTask = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/tasks",
        body: {
          task_id: "task-operator-pending-1",
          idempotency_key: "idem-operator-pending-1",
          requester: { id: "tonya", kind: "operator" },
          target: { capability: "marketing", team_id: "marketing" },
          objective: "Queue an out-of-order delegated receipt",
          tier: "STANDARD",
          acceptance_criteria: ["receipt eventually applies"],
          timeout_s: 900,
          execution: {
            transport: "manual",
            runtime: "acpx",
            durable: true,
          },
        },
      });
      expect(createTask.statusCode).toBe(201);

      const createdPayload = JSON.parse(String(createTask.body)) as {
        task: { receipt: { run_id: string } };
      };

      const queuedReceipt = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/tasks/task-operator-pending-1/receipts",
        body: {
          schema: "AngelaTaskReceiptV1",
          task_id: "task-operator-pending-1",
          run_id: createdPayload.task.receipt.run_id,
          state: "started",
          attempt: 0,
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_000_100,
          summary: "delegate started work",
        },
      });
      expect(queuedReceipt.statusCode).toBe(202);
      expect(JSON.parse(String(queuedReceipt.body))).toMatchObject({
        queued: true,
      });

      const queueTask = await requestMissionControl({
        method: "PATCH",
        url: "/mission-control/api/tasks/task-operator-pending-1",
        body: {
          state: "queued",
          owner: "tonys-angels",
        },
      });
      expect(queueTask.statusCode).toBe(200);

      expect(processPendingReceipts()).toMatchObject({
        processed: 1,
        applied: 1,
        requeued: 0,
      });

      const task = await requestMissionControl({
        method: "GET",
        url: "/mission-control/api/tasks/task-operator-pending-1",
      });
      expect(task.statusCode).toBe(200);
      expect(JSON.parse(String(task.body))).toMatchObject({
        receipt: {
          state: "started",
        },
      });
    });
  });

  it("forwards operator task lifecycle snapshots through the Tonya project-ops control plane when configured", async () => {
    await withStateDirEnv("openclaw-mc-operator-deb-sync-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        json: async () => ({
          ok: true,
          message: "stored",
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_CONTROL_PLANE_URL: "http://tonya.internal:18789",
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "tonya-control-secret",
        },
        async () => {
          const created = await requestMissionControl({
            method: "POST",
            url: "/mission-control/api/tasks",
            body: {
              task_id: "task-operator-deb-sync-1",
              idempotency_key: "idem-operator-deb-sync-1",
              requester: { id: "tonya", kind: "operator" },
              target: { capability: "marketing", team_id: "marketing" },
              objective: "Verify Deb sync for accepted tasks",
              tier: "STANDARD",
              acceptance_criteria: ["Deb receives accepted lifecycle snapshot"],
              timeout_s: 900,
              execution: {
                transport: "manual",
                runtime: "acpx",
                durable: true,
              },
            },
          });

          expect(created.statusCode).toBe(201);
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = getFetchMockCall(fetchMock, 0);
      expect(url).toBe(
        "http://tonya.internal:18789/mission-control/api/project-ops/operator/events",
      );
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer tonya-control-secret",
      );
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        schema: "DebOperatorTaskSyncV1",
        reason: "submit",
        task_id: "task-operator-deb-sync-1",
        state: "accepted",
        team_id: "marketing",
        capability: "marketing",
      });
    });
  });

  it("proxies project-ops update calls to the internal Deb service", async () => {
    await withStateDirEnv("openclaw-mc-project-ops-proxy-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({
          "content-type": "application/json; charset=utf-8",
        }),
        text: async () =>
          JSON.stringify({
            ok: true,
            message: "stored",
          }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
          OPENCLAW_OPERATOR_DEB_SHARED_SECRET: "deb-upstream-secret",
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "tonya-control-secret",
        },
        async () => {
          const proxied = await requestMissionControl({
            method: "POST",
            url: "/mission-control/api/project-ops/update",
            body: {
              item_url: "https://github.com/sasan1200/openclaw/issues/1",
              set: {
                status: "Done",
              },
              clear: ["curr"],
            },
            headers: {
              authorization: "Bearer tonya-control-secret",
            },
          });

          expect(proxied.statusCode).toBe(200);
          expect(JSON.parse(String(proxied.body))).toMatchObject({
            ok: true,
            message: "stored",
          });
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = getFetchMockCall(fetchMock, 0);
      expect(url).toBe("http://deb.internal:3010/update");
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer deb-upstream-secret",
      );
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? "")),
      ).toMatchObject({
        item_url: "https://github.com/sasan1200/openclaw/issues/1",
        set: {
          status: "Done",
        },
        clear: ["curr"],
      });
    });
  });

  it("routes project-ops Paw and Order tasks into Deb inside Tonya", async () => {
    await withStateDirEnv("openclaw-mc-project-ops-task-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        text: async () =>
          JSON.stringify({
            ok: true,
            status: "accepted",
            delegatedRunId: "delegated-deb-1",
            agentId: "deb",
            callbackRegistered: true,
          }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "tonya-control-secret",
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://tonya.internal:18789",
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET: "tonya-internal-secret",
          OPENCLAW_OPERATOR_RECEIPT_BASE_URL: "http://tonya.internal:18789",
        },
        async () => {
          const proxied = await requestMissionControl({
            method: "POST",
            url: "/mission-control/api/project-ops/task",
            body: {
              schema: "PawAndOrderTaskV1",
              task_id: "task-project-ops-1",
              run_id: "run-project-ops-1",
              objective: "Normalize blockers and ownership",
              capability: "kanban",
              team_id: "project-ops",
              alias: "jeffy",
              specialist_role: "jeffy",
              artifact_type: "board_hygiene_packet",
              delivery_mode: "sync-now",
              requester: {
                id: "tonya",
                kind: "operator",
              },
              acceptance_criteria: ["board packet queued through Deb"],
              context_refs: [],
              inputs: {
                blocker_focus: true,
              },
            },
            headers: {
              authorization: "Bearer tonya-control-secret",
            },
          });

          expect(proxied.statusCode).toBe(202);
          expect(JSON.parse(String(proxied.body))).toMatchObject({
            ok: true,
            status: "accepted",
            owner: "deb",
            agentId: "deb",
            taskId: "task-project-ops-1",
            runId: "run-project-ops-1",
            specialistRole: "jeffy",
          });
        },
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const { url, init } = getFetchMockCall(fetchMock, 0);
      expect(url).toBe("http://tonya.internal:18789/api/message");
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer tonya-internal-secret",
      );
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        schema: "AngelaTaskEnvelopeV1",
        task_id: "task-project-ops-1",
        run_id: "run-project-ops-1",
        callback_url:
          "http://tonya.internal:18789/mission-control/api/tasks/task-project-ops-1/receipts",
        team_id: "project-ops",
        team_lead: "deb",
        alias: "deb",
        execution: {
          transport: "delegated-http",
          runtime: "subagent",
          durable: true,
        },
      });
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)).inputs,
      ).toMatchObject({
        specialist_role: "jeffy",
        dog_role: "jeffy",
        artifact_type: "board_hygiene_packet",
        delivery_mode: "sync-now",
        requested_alias: "jeffy",
        orchestration_source: "mission-control-project-ops-task",
      });
    });
  });

  it("rejects stale service-context writes with a client-visible error", async () => {
    await withStateDirEnv("openclaw-mc-operator-http-stale-", async () => {
      const first = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/memory/service-context",
        body: {
          service: "mission-control",
          summary: "Fresh state",
          content: {
            role: "operator-surface",
          },
          metadata: {
            source: "operator-http-test",
            writer: "tonya",
            evidence_ref: "task://fresh",
            verified_at: 1_700_000_000_500,
          },
        },
      });
      expect(first.statusCode).toBe(201);

      const stale = await requestMissionControl({
        method: "POST",
        url: "/mission-control/api/memory/service-context",
        body: {
          service: "mission-control",
          summary: "Stale state",
          content: {
            role: "stale",
          },
          metadata: {
            source: "operator-http-test",
            writer: "tonya",
            evidence_ref: "task://stale",
            verified_at: 1_700_000_000_400,
          },
        },
      });
      expect(stale.statusCode).toBe(400);
      const payload = JSON.parse(String(stale.body)) as { error: { message: string } };
      expect(payload.error.message).toContain("stale memory update rejected");
    });
  });

  it("proxies worker task list, detail, events, and cancel through mission control", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            status: "ok",
            pending: 1,
            active: 0,
            shuttingDown: false,
            backend: {
              mode: "filesystem",
              persistenceEnabled: true,
              stateFile: "/var/lib/agents/2tony/queue-state.json",
              recoveredTasks: 1,
            },
          }),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            tasks: [
              {
                taskId: "worker-task-1",
                runId: "worker-run-1",
                type: "backend",
                priority: "normal",
                state: "queued",
                attempt: 0,
                createdAt: 1_700_000_000_000,
                updatedAt: 1_700_000_000_100,
              },
            ],
            stats: {
              pending: 1,
              active: 0,
              shuttingDown: false,
            },
          }),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            taskId: "worker-task-1",
            runId: "worker-run-1",
            type: "backend",
            priority: "normal",
            state: "queued",
            attempt: 0,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_100,
          }),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            taskId: "worker-task-1",
            runId: "worker-run-1",
            events: [
              {
                id: "evt-1",
                at: 1_700_000_000_100,
                state: "queued",
              },
            ],
          }),
        status: 200,
        statusText: "OK",
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            taskId: "worker-task-1",
            cancelled: true,
            message: "cancelled pending task",
            task: {
              taskId: "worker-task-1",
              runId: "worker-run-1",
              type: "backend",
              priority: "normal",
              state: "dead-letter",
              attempt: 0,
              createdAt: 1_700_000_000_000,
              updatedAt: 1_700_000_000_200,
            },
          }),
        status: 200,
        statusText: "OK",
      });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await withEnvAsync(
      {
        OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
      },
      async () => {
        const ready = await requestMissionControl({
          method: "GET",
          url: "/mission-control/api/worker/ready",
        });
        expect(ready.statusCode).toBe(200);
        expect(JSON.parse(String(ready.body))).toMatchObject({
          status: "ok",
          backend: {
            mode: "filesystem",
          },
        });

        const list = await requestMissionControl({
          method: "GET",
          url: "/mission-control/api/worker/tasks?limit=10",
        });
        expect(list.statusCode).toBe(200);
        expect(JSON.parse(String(list.body))).toMatchObject({
          tasks: [{ taskId: "worker-task-1" }],
        });

        const detail = await requestMissionControl({
          method: "GET",
          url: "/mission-control/api/worker/tasks/worker-task-1",
        });
        expect(detail.statusCode).toBe(200);
        expect(JSON.parse(String(detail.body))).toMatchObject({
          taskId: "worker-task-1",
        });

        const events = await requestMissionControl({
          method: "GET",
          url: "/mission-control/api/worker/tasks/worker-task-1/events",
        });
        expect(events.statusCode).toBe(200);
        expect(JSON.parse(String(events.body))).toMatchObject({
          events: [{ state: "queued" }],
        });

        const cancel = await requestMissionControl({
          method: "POST",
          url: "/mission-control/api/worker/tasks/worker-task-1/cancel",
        });
        expect(cancel.statusCode).toBe(200);
        expect(JSON.parse(String(cancel.body))).toMatchObject({
          cancelled: true,
        });
      },
    );
  });
});
