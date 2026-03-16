import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { invalidateRegistryCache } from "./agent-registry.js";
import { dispatchOperatorTask, submitOperatorTaskAndDispatch } from "./dispatch.js";
import { resolveOperatorReferenceSourcePath } from "./reference-paths.js";
import { getOperatorTask, submitOperatorTask } from "./task-store.js";
import {
  getOperatorTransportCircuitSnapshot,
  resetOperatorTransportCircuitBreakers,
} from "./transport-circuit-breaker.js";

function create2TonyFetchMock(
  taskResponse?: Record<string, unknown>,
  readyResponse?: Record<string, unknown>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/ready")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          pending: 0,
          active: 0,
          shuttingDown: false,
          auth: { enabled: true, scheme: "bearer" },
          backend: {
            mode: "memory",
            persistenceEnabled: true,
            stateFile: null,
            recoveredTasks: 0,
          },
          ...readyResponse,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify(
        taskResponse ?? {
          taskId: "task-dispatch-1",
          status: "accepted",
          runId: "task-run-dispatch-1",
        },
      ),
      { status: 202, headers: { "content-type": "application/json" } },
    );
  });
}

function createHttpDelegateFetchMock(options: {
  actionResponse: Record<string, unknown>;
  actionStatus: number;
  actionStatusText: string;
  readyStatus?: number;
  readyStatusText?: string;
  readyBody?: Record<string, unknown>;
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/ready")) {
      return new Response(JSON.stringify(options.readyBody ?? { ready: true }), {
        status: options.readyStatus ?? 200,
        statusText: options.readyStatusText ?? "OK",
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(options.actionResponse), {
      status: options.actionStatus,
      statusText: options.actionStatusText,
      headers: { "content-type": "application/json" },
    });
  });
}

function getFetchMockCall(
  fetchMock: ReturnType<typeof vi.fn>,
  index: number,
): {
  url: string;
  init: RequestInit;
} {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`No fetch call at index ${index}`);
  }
  const input = call[0];
  return {
    url:
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input?.url ?? ""),
    init: (call[1] ?? {}) as RequestInit,
  };
}

function getDispatchMessage(dispatch: {
  attempted: boolean;
  message?: string;
  reason?: string;
}): string {
  return dispatch.attempted && "message" in dispatch
    ? (dispatch.message ?? "")
    : (dispatch.reason ?? "");
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

describe("operator task dispatch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    vi.restoreAllMocks();
    resetOperatorTransportCircuitBreakers();
    await seedOperatorRegistryFixture();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("submits and dispatches operator tasks to 2Tony when configured", async () => {
    await withStateDirEnv("operator-dispatch-", async () => {
      const fetchMock = create2TonyFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
          OPENCLAW_OPERATOR_RECEIPT_URL:
            "http://gateway.internal/mission-control/api/tasks/task-dispatch-1/receipts",
          OPENCLAW_OPERATOR_2TONY_SHARED_SECRET: "top-secret-2tony",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-1",
            idempotency_key: "task-dispatch-1",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Dispatch to 2Tony",
            tier: "STANDARD",
            inputs: {
              worker_task_type: "git-status",
            },
            acceptance_criteria: ["queued in worker"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      expect(result.created).toBe(true);
      expect(result.task.receipt.state).toBe("queued");
      expect(result.task.receipt.owner).toBe("2tony");
      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://2tony.internal:3009/task",
        statusCode: 202,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer top-secret-2tony",
      );
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        type: "git-status",
        metadata: {
          capability: "backend",
          workerTaskType: "git-status",
        },
      });
      const task = getOperatorTask("task-dispatch-1");
      expect(task?.receipt.state).toBe("queued");
      expect(task?.receipt.owner).toBe("2tony");
    });
  });

  it("returns a non-attempted dispatch result when 2Tony is not configured", async () => {
    await withStateDirEnv("operator-dispatch-unconfigured-", async () => {
      submitOperatorTask({
        task_id: "task-dispatch-2",
        idempotency_key: "task-dispatch-2",
        requester: { id: "tonya", kind: "operator" },
        target: { capability: "infra" },
        objective: "Unconfigured worker",
        tier: "HEAVY",
        acceptance_criteria: ["clear reason returned"],
        timeout_s: 900,
        execution: {
          transport: "2tony-http",
          runtime: "acpx",
          durable: true,
        },
      });

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: undefined,
          BT_2TONY_BASE_URL: undefined,
          TWO_TONY_BASE_URL: undefined,
        },
        async () => await dispatchOperatorTask("task-dispatch-2"),
      );

      expect(result).toEqual({
        attempted: false,
        reason: "2Tony base URL not configured",
      });
    });
  });

  it("omits 2Tony bearer auth when no shared secret is configured", async () => {
    await withStateDirEnv("operator-dispatch-no-2tony-secret-", async () => {
      const fetchMock = create2TonyFetchMock({
        taskId: "task-dispatch-2tony-no-secret",
        status: "accepted",
        runId: "task-run-dispatch-2tony-no-secret",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
          OPENCLAW_OPERATOR_RECEIPT_URL:
            "http://gateway.internal/mission-control/api/tasks/task-dispatch-2tony-no-secret/receipts",
          OPENCLAW_OPERATOR_2TONY_SHARED_SECRET: undefined,
          BT_2TONY_SHARED_SECRET: undefined,
          TWO_TONY_SHARED_SECRET: undefined,
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-2tony-no-secret",
            idempotency_key: "task-dispatch-2tony-no-secret",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Dispatch to 2Tony without auth",
            tier: "STANDARD",
            inputs: {
              worker_task_type: "git-status",
            },
            acceptance_criteria: ["queued in worker"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });

  it("infers a concrete 2Tony task type from operator inputs", async () => {
    await withStateDirEnv("operator-dispatch-2tony-infer-", async () => {
      const fetchMock = create2TonyFetchMock({
        taskId: "task-dispatch-infer",
        status: "accepted",
        runId: "task-run-dispatch-infer",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-infer",
            idempotency_key: "task-dispatch-infer",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "infrastructure", alias: "ghostface" },
            objective: "Validate manifest",
            tier: "STANDARD",
            inputs: {
              manifest: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
            },
            acceptance_criteria: ["worker receives validate-k8s payload"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      const { init } = getFetchMockCall(fetchMock, 1);
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        type: "validate-k8s",
        payload: {
          manifest: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
          inputs: {
            manifest: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
          },
        },
        metadata: {
          capability: "infrastructure",
          workerTaskType: "validate-k8s",
        },
      });
    });
  });

  it("blocks unmappable execution-fleet capabilities before 2Tony dead-letters them", async () => {
    await withStateDirEnv("operator-dispatch-2tony-unmappable-", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-unmappable",
            idempotency_key: "task-dispatch-unmappable",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Backend task without concrete worker hints",
            tier: "STANDARD",
            acceptance_criteria: ["task blocks early"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: false,
        endpoint: "http://2tony.internal:3009/task",
        statusCode: 0,
      });
      expect(getDispatchMessage(result.dispatch)).toContain("could not be inferred");
      const task = getOperatorTask("task-dispatch-unmappable");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("unmapped_task_type");
    });
  });

  it("treats generic operator taskType as intent and blocks with unmapped_task_type", async () => {
    await withStateDirEnv("operator-dispatch-generic-engineering-", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-engineering",
            idempotency_key: "task-dispatch-engineering",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Generic engineering task should not leak downstream",
            tier: "STANDARD",
            inputs: {
              taskType: "engineering",
            },
            acceptance_criteria: ["task blocks before worker dead-letter"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(getDispatchMessage(result.dispatch)).toContain("could not be inferred");
      const task = getOperatorTask("task-dispatch-engineering");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("unmapped_task_type");
    });
  });

  it("blocks dispatch when the operator runtime freshness policy is not satisfied", async () => {
    await withStateDirEnv("operator-dispatch-stale-runtime-", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
          OPENCLAW_OPERATOR_APPROVED_REFS: "main",
          OPENCLAW_GIT_BRANCH: "stale/tonya",
          GIT_COMMIT: "abcdef0123456789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-stale-runtime",
            idempotency_key: "task-dispatch-stale-runtime",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Dispatch should fail closed on stale runtime",
            tier: "STANDARD",
            inputs: {
              worker_task_type: "git-status",
            },
            acceptance_criteria: ["task blocks early"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(getDispatchMessage(result.dispatch)).toContain("operator runtime not ready");
      const task = getOperatorTask("task-dispatch-stale-runtime");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("stale_runtime");
    });
  });

  it("blocks dispatch when 2Tony exposes stale runtime identity", async () => {
    await withStateDirEnv("operator-dispatch-stale-worker-runtime-", async () => {
      const fetchMock = create2TonyFetchMock(undefined, {
        identity: {
          version: "2026.3.11",
          commit: "abcdef0123456789",
          branch: "feature/stale",
          builtAt: "2026-03-01T00:00:00.000Z",
          runtimeType: "embedded",
        },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
          OPENCLAW_OPERATOR_WORKER_APPROVED_REFS: "main",
          OPENCLAW_OPERATOR_WORKER_MAX_AGE_HOURS: "24",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-stale-worker-runtime",
            idempotency_key: "task-dispatch-stale-worker-runtime",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Dispatch should fail closed on stale worker runtime",
            tier: "STANDARD",
            inputs: {
              worker_task_type: "git-status",
            },
            acceptance_criteria: ["task blocks early"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      expect(getDispatchMessage(result.dispatch)).toContain("2Tony runtime not ready");
      const task = getOperatorTask("task-dispatch-stale-worker-runtime");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("stale_runtime");
    });
  });

  it("opens and recovers the delegated transport circuit breaker after repeated failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-13T12:00:00.000Z"));

    await withStateDirEnv("operator-dispatch-delegated-circuit-", async () => {
      const failingFetch = createHttpDelegateFetchMock({
        actionResponse: { ok: true },
        actionStatus: 200,
        actionStatusText: "OK",
        readyStatus: 503,
        readyStatusText: "Service Unavailable",
      });
      globalThis.fetch = failingFetch as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_ANGELA_URL: "http://angela.internal:3011",
        },
        async () => {
          for (let index = 1; index <= 5; index += 1) {
            await submitOperatorTaskAndDispatch({
              task_id: `task-delegated-circuit-${index}`,
              idempotency_key: `task-delegated-circuit-${index}`,
              requester: { id: "tonya", kind: "operator" },
              target: { capability: "marketing", alias: "tonys-angels" },
              objective: "Trip the delegated transport circuit",
              tier: "STANDARD",
              acceptance_criteria: ["dispatch blocks"],
              timeout_s: 900,
              execution: {
                transport: "delegated-http",
                runtime: "acpx",
                durable: true,
              },
            });
          }

          expect(getOperatorTransportCircuitSnapshot("delegated-http").state).toBe("open");

          const callsBeforeOpenBlock = failingFetch.mock.calls.length;
          const blocked = await submitOperatorTaskAndDispatch({
            task_id: "task-delegated-circuit-open-block",
            idempotency_key: "task-delegated-circuit-open-block",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", alias: "tonys-angels" },
            objective: "Circuit should short-circuit",
            tier: "STANDARD",
            acceptance_criteria: ["dispatch blocks before fetch"],
            timeout_s: 900,
            execution: {
              transport: "delegated-http",
              runtime: "acpx",
              durable: true,
            },
          });

          expect(getDispatchMessage(blocked.dispatch)).toContain("transport circuit open");
          expect(failingFetch.mock.calls.length).toBe(callsBeforeOpenBlock);

          vi.setSystemTime(new Date("2026-03-13T12:01:01.000Z"));
          const recoveredFetch = createHttpDelegateFetchMock({
            actionResponse: { ok: true, status: "accepted" },
            actionStatus: 202,
            actionStatusText: "Accepted",
            readyBody: { ready: true },
          });
          globalThis.fetch = recoveredFetch as unknown as typeof fetch;

          const recovered = await submitOperatorTaskAndDispatch({
            task_id: "task-delegated-circuit-recovered",
            idempotency_key: "task-delegated-circuit-recovered",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", alias: "tonys-angels" },
            objective: "Half-open probe should recover the circuit",
            tier: "STANDARD",
            acceptance_criteria: ["dispatch succeeds"],
            timeout_s: 900,
            execution: {
              transport: "delegated-http",
              runtime: "acpx",
              durable: true,
            },
          });

          expect(recovered.dispatch).toMatchObject({
            attempted: true,
            accepted: true,
            endpoint: "http://angela.internal:3011/api/message",
            statusCode: 202,
          });
          expect(getOperatorTransportCircuitSnapshot("delegated-http").state).toBe("closed");
        },
      );
    });
  });

  it("dispatches project-ops tasks to Deb when team routing selects deb-http", async () => {
    await withStateDirEnv("operator-dispatch-deb-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          ok: true,
          output: "Deb Board Status",
        },
        actionStatus: 200,
        actionStatusText: "OK",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-3",
            idempotency_key: "task-dispatch-3",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "sprint", team_id: "project-ops" },
            objective: "Sync project board status",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["deb status captured"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://deb.internal:3010/status",
        statusCode: 200,
      });
      const task = getOperatorTask("task-dispatch-3");
      expect(task?.receipt.state).toBe("completed");
      expect(task?.receipt.owner).toBe("deb");
      expect(task?.envelope.execution.transport).toBe("deb-http");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });

  it("routes project-ops tasks through the Tonya control plane when configured", async () => {
    await withStateDirEnv("operator-dispatch-project-ops-proxy-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          ok: true,
          output: "Tonya project-ops proxy accepted update",
        },
        actionStatus: 200,
        actionStatusText: "OK",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_CONTROL_PLANE_URL: "http://tonya.internal:18789",
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "top-secret-control-plane",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-project-ops-proxy",
            idempotency_key: "task-dispatch-project-ops-proxy",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "sprint", team_id: "project-ops" },
            objective: "Sync project board status through Tonya",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["project-ops status captured"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://tonya.internal:18789/mission-control/api/project-ops/status",
        statusCode: 200,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer top-secret-control-plane",
      );
      const task = getOperatorTask("task-dispatch-project-ops-proxy");
      expect(task?.receipt.state).toBe("completed");
      expect(task?.receipt.owner).toBe("deb");
    });
  });

  it("blocks legacy 2Tony dispatch when a task requests subagent runtime", async () => {
    await withStateDirEnv("operator-dispatch-2tony-subagent-runtime-", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_2TONY_URL: "http://2tony.internal:3009",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-2tony-subagent-runtime",
            idempotency_key: "task-dispatch-2tony-subagent-runtime",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", alias: "raekwon" },
            objective: "Do not route legacy worker tasks through subagent runtime",
            tier: "STANDARD",
            inputs: {
              worker_task_type: "git-status",
            },
            acceptance_criteria: ["dispatch blocks before contacting 2Tony"],
            timeout_s: 900,
            execution: {
              transport: "2tony-http",
              runtime: "subagent",
              durable: true,
            },
          }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(getDispatchMessage(result.dispatch)).toContain(
        "transport 2tony-http does not support runtime subagent",
      );
      const task = getOperatorTask("task-dispatch-2tony-subagent-runtime");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("dispatch_failed");
    });
  });

  it("sends the Deb shared secret when configured", async () => {
    await withStateDirEnv("operator-dispatch-deb-secret-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          ok: true,
        },
        actionStatus: 200,
        actionStatusText: "OK",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
          OPENCLAW_OPERATOR_DEB_SHARED_SECRET: "top-secret-deb",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-secret",
            idempotency_key: "task-dispatch-deb-secret",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "sprint", team_id: "project-ops" },
            objective: "Dispatch Deb with auth",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["deb accepted the request"],
            timeout_s: 900,
          }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer top-secret-deb");
    });
  });

  it("dispatches Paw and Order specialist tasks to Deb /task with structured payload", async () => {
    await withStateDirEnv("operator-dispatch-paw-and-order-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          ok: true,
          status: "accepted",
          output: "Deb accepted task for jeffy",
          owner: "deb",
          agentId: "deb",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_CONTROL_PLANE_URL: "http://tonya.internal:18789",
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "top-secret-control-plane",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-paw-and-order",
            idempotency_key: "task-dispatch-paw-and-order",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "kanban", team_id: "project-ops" },
            objective: "Clean up board ownership and blockers",
            tier: "STANDARD",
            inputs: {
              artifact_type: "board_hygiene_packet",
              delivery_mode: "sync-now",
            },
            acceptance_criteria: ["paw and order task accepted"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://tonya.internal:18789/mission-control/api/project-ops/task",
        statusCode: 202,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer top-secret-control-plane",
      );
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        schema: "PawAndOrderTaskV1",
        capability: "kanban",
        specialist_role: "jeffy",
        dog_role: "jeffy",
        artifact_type: "board_hygiene_packet",
        delivery_mode: "sync-now",
      });

      const task = getOperatorTask("task-dispatch-paw-and-order");
      expect(task?.receipt.state).toBe("queued");
      expect(task?.receipt.owner).toBe("deb");
    });
  });

  it("preserves explicit Deb command overrides even when project-ops routing selects a Paw and Order alias", async () => {
    await withStateDirEnv("operator-dispatch-deb-explicit-command-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          ok: true,
          output: "Deb status synced",
        },
        actionStatus: 200,
        actionStatusText: "OK",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
          OPENCLAW_OPERATOR_DEB_SHARED_SECRET: "top-secret-deb",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-explicit-command",
            idempotency_key: "task-dispatch-deb-explicit-command",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "kanban", team_id: "project-ops" },
            objective: "Check Deb status without creating a Paw and Order task",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["deb status captured"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://deb.internal:3010/status",
        statusCode: 200,
      });
    });
  });

  it("ignores generic command fields when inferring Deb Paw and Order dispatch", async () => {
    await withStateDirEnv("operator-dispatch-deb-generic-command-ignored-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          ok: true,
          status: "accepted",
          output: "Deb accepted task for jeffy",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_CONTROL_PLANE_URL: "http://tonya.internal:18789",
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "top-secret-control-plane",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-generic-command-ignored",
            idempotency_key: "task-dispatch-deb-generic-command-ignored",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "kanban", team_id: "project-ops" },
            objective: "Dispatch Paw and Order task without transport hijack",
            tier: "STANDARD",
            inputs: {
              command: "status",
              artifact_type: "board_hygiene_packet",
            },
            acceptance_criteria: ["paw and order task accepted"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://tonya.internal:18789/mission-control/api/project-ops/task",
        statusCode: 202,
      });
    });
  });

  it("reports the inferred Deb endpoint when Paw and Order dispatch fails before fetch returns", async () => {
    await withStateDirEnv("operator-dispatch-deb-failure-endpoint-", async () => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/ready")) {
          return new Response(JSON.stringify({ ready: true }), {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error("network down");
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_CONTROL_PLANE_URL: "http://tonya.internal:18789",
          OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "top-secret-control-plane",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-failure-endpoint",
            idempotency_key: "task-dispatch-deb-failure-endpoint",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "kanban", team_id: "project-ops" },
            objective: "Surface the correct failed Deb endpoint",
            tier: "STANDARD",
            inputs: {
              artifact_type: "board_hygiene_packet",
            },
            acceptance_criteria: ["paw and order task accepted"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: false,
        endpoint: "http://tonya.internal:18789/mission-control/api/project-ops/task",
        statusCode: 0,
        message: "network down",
      });
      const task = getOperatorTask("task-dispatch-deb-failure-endpoint");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("dispatch_failed");
    });
  });

  it("blocks Deb dispatch when the delegate readiness probe fails", async () => {
    await withStateDirEnv("operator-dispatch-deb-not-ready-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: { ok: true },
        actionStatus: 200,
        actionStatusText: "OK",
        readyStatus: 503,
        readyStatusText: "Service Unavailable",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-not-ready",
            idempotency_key: "task-dispatch-deb-not-ready",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "sprint", team_id: "project-ops" },
            objective: "Do not dispatch into an unhealthy Deb",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["dispatch blocks"],
            timeout_s: 900,
          }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getDispatchMessage(result.dispatch)).toContain("Deb not ready");
      const task = getOperatorTask("task-dispatch-deb-not-ready");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("delegate_unavailable");
    });
  });

  it("blocks Deb dispatch when the delegate runtime identity is stale", async () => {
    await withStateDirEnv("operator-dispatch-deb-stale-runtime-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: { ok: true },
        actionStatus: 200,
        actionStatusText: "OK",
        readyBody: {
          ready: true,
          identity: {
            version: "2026.3.01",
            commit: "abcdef0123456789",
            branch: "tony-home-main",
            builtAt: "2026-03-01T00:00:00.000Z",
            runtimeType: "embedded",
          },
        },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
          OPENCLAW_OPERATOR_DEB_MAX_AGE_HOURS: "24",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-stale-runtime",
            idempotency_key: "task-dispatch-deb-stale-runtime",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "sprint", team_id: "project-ops" },
            objective: "Block stale Deb runtime",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["dispatch blocks"],
            timeout_s: 900,
          }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getDispatchMessage(result.dispatch)).toContain("Deb runtime not ready for dispatch");
      const task = getOperatorTask("task-dispatch-deb-stale-runtime");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("stale_runtime");
    });
  });

  it("blocks Deb dispatch when a 2xx response does not satisfy the expected contract", async () => {
    await withStateDirEnv("operator-dispatch-deb-invalid-contract-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: { status: "ok" },
        actionStatus: 200,
        actionStatusText: "OK",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-deb-invalid-contract",
            idempotency_key: "task-dispatch-deb-invalid-contract",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "sprint", team_id: "project-ops" },
            objective: "Require a real Deb acknowledgment",
            tier: "STANDARD",
            inputs: {
              deb_command: "status",
            },
            acceptance_criteria: ["dispatch blocks"],
            timeout_s: 900,
          }),
      );

      expect(getDispatchMessage(result.dispatch)).toContain("Deb response did not satisfy");
      const task = getOperatorTask("task-dispatch-deb-invalid-contract");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("dispatch_failed");
    });
  });

  it("dispatches marketing tasks through the delegated first-class-agent boundary", async () => {
    await withStateDirEnv("operator-dispatch-angela-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          status: "accepted",
          message: "Angela queued campaign request",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://angela.internal:18789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-4",
            idempotency_key: "task-dispatch-4",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", team_id: "marketing" },
            objective: "Kick off investor messaging package",
            tier: "STANDARD",
            inputs: {
              campaign: "series-a-prep",
            },
            acceptance_criteria: ["angela accepted the brief"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://angela.internal:18789/api/message",
        statusCode: 202,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { url: endpoint, init } = getFetchMockCall(fetchMock, 1);
      expect(endpoint).toBe("http://angela.internal:18789/api/message");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        schema: "AngelaTaskEnvelopeV1",
        task_id: "task-dispatch-4",
        capability: "marketing",
        team_id: "marketing",
        alias: "tonys-angels",
      });
      const task = getOperatorTask("task-dispatch-4");
      expect(task?.receipt.state).toBe("queued");
      expect(task?.receipt.owner).toBe("tonys-angels");
      expect(task?.events.at(-1)?.note).toContain(
        "dispatched to tonys-angels via delegated first-class-agent boundary",
      );
      expect(task?.envelope.execution.transport).toBe("delegated-http");
    });
  });

  it("dispatches engineering tasks to Bobby through the delegated first-class-agent boundary", async () => {
    await withStateDirEnv("operator-dispatch-engineering-bobby-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          status: "accepted",
          message: "Bobby queued engineering request",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://tonya.internal:18789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-engineering-bobby",
            idempotency_key: "task-dispatch-engineering-bobby",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "backend", team_id: "engineering" },
            objective: "Route backend regression through Bobby",
            tier: "STANDARD",
            inputs: {
              repo: "openclaw",
            },
            acceptance_criteria: ["Bobby accepted engineering intake"],
            timeout_s: 900,
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://tonya.internal:18789/api/message",
        statusCode: 202,
      });
      const { init } = getFetchMockCall(fetchMock, 1);
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        schema: "AngelaTaskEnvelopeV1",
        task_id: "task-dispatch-engineering-bobby",
        capability: "backend",
        team_id: "engineering",
        alias: "bobby-digital",
      });
      const task = getOperatorTask("task-dispatch-engineering-bobby");
      expect(task?.receipt.state).toBe("queued");
      expect(task?.receipt.owner).toBe("bobby-digital");
      expect(task?.events.at(-1)?.note).toContain(
        "dispatched to bobby-digital via delegated first-class-agent boundary",
      );
      expect(task?.envelope.execution.transport).toBe("delegated-http");
    });
  });

  it("uses the global angela-http default alias when a delegated task has no team or alias", async () => {
    await withStateDirEnv("operator-dispatch-angela-global-default-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          status: "accepted",
          message: "Global angela-http default accepted request",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://tonya.internal:18789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-angela-global-default",
            idempotency_key: "task-dispatch-angela-global-default",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing" },
            objective: "Route through configured global angela-http fallback",
            tier: "STANDARD",
            acceptance_criteria: ["global fallback accepted"],
            timeout_s: 900,
            execution: {
              transport: "angela-http",
              runtime: "acpx",
              durable: true,
            },
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://tonya.internal:18789/api/message",
        statusCode: 202,
      });
      const { init } = getFetchMockCall(fetchMock, 1);
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        schema: "AngelaTaskEnvelopeV1",
        task_id: "task-dispatch-angela-global-default",
        capability: "marketing",
        alias: "tonys-angels",
      });
      const task = getOperatorTask("task-dispatch-angela-global-default");
      expect(task?.receipt.state).toBe("queued");
      expect(task?.receipt.owner).toBe("tonys-angels");
    });
  });

  it("allows delegated first-class-agent dispatch when a task explicitly requests subagent runtime", async () => {
    await withStateDirEnv("operator-dispatch-angela-subagent-runtime-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          status: "accepted",
          message: "Delegated subagent request accepted",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://tonya.internal:18789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-angela-subagent-runtime",
            idempotency_key: "task-dispatch-angela-subagent-runtime",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", team_id: "marketing" },
            objective: "Route delegated work through the subagent runtime",
            tier: "STANDARD",
            acceptance_criteria: ["delegated transport accepts subagent runtime"],
            timeout_s: 900,
            execution: {
              transport: "angela-http",
              runtime: "subagent",
              durable: true,
            },
          }),
      );

      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://tonya.internal:18789/api/message",
        statusCode: 202,
      });
      const { init } = getFetchMockCall(fetchMock, 1);
      expect(
        JSON.parse(typeof init.body === "string" ? init.body : JSON.stringify(init.body)),
      ).toMatchObject({
        execution: {
          transport: "delegated-http",
          runtime: "subagent",
          durable: true,
        },
      });
    });
  });

  it("sends the Angela shared secret when configured", async () => {
    await withStateDirEnv("operator-dispatch-angela-secret-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: {
          status: "accepted",
        },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://angela.internal:18789",
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_SHARED_SECRET: "top-secret-angela",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-5",
            idempotency_key: "task-dispatch-5",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", team_id: "marketing" },
            objective: "Dispatch with auth",
            tier: "STANDARD",
            acceptance_criteria: ["angela accepted the brief"],
            timeout_s: 900,
          }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const { init } = getFetchMockCall(fetchMock, 1);
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer top-secret-angela",
      );
    });
  });

  it("blocks Angela dispatch when the delegate readiness probe fails", async () => {
    await withStateDirEnv("operator-dispatch-angela-not-ready-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: { status: "accepted" },
        actionStatus: 202,
        actionStatusText: "Accepted",
        readyStatus: 503,
        readyStatusText: "Service Unavailable",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://angela.internal:18789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-angela-not-ready",
            idempotency_key: "task-dispatch-angela-not-ready",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", team_id: "marketing" },
            objective: "Do not dispatch into an unhealthy Angela",
            tier: "STANDARD",
            acceptance_criteria: ["dispatch blocks"],
            timeout_s: 900,
          }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getDispatchMessage(result.dispatch)).toContain(
        "tonys-angels via delegated first-class-agent boundary not ready",
      );
      const task = getOperatorTask("task-dispatch-angela-not-ready");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("delegate_unavailable");
    });
  });

  it("blocks Angela dispatch when the delegate runtime identity is stale", async () => {
    await withStateDirEnv("operator-dispatch-angela-stale-runtime-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: { status: "accepted" },
        actionStatus: 202,
        actionStatusText: "Accepted",
        readyBody: {
          ready: true,
          identity: {
            version: "2026.3.01",
            commit: "abcdef0123456789",
            branch: "tony-home-main",
            builtAt: "2026-03-01T00:00:00.000Z",
            runtimeType: "embedded",
          },
        },
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://angela.internal:18789",
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_MAX_AGE_HOURS: "24",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-angela-stale-runtime",
            idempotency_key: "task-dispatch-angela-stale-runtime",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", team_id: "marketing" },
            objective: "Block stale Angela runtime",
            tier: "STANDARD",
            acceptance_criteria: ["dispatch blocks"],
            timeout_s: 900,
          }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getDispatchMessage(result.dispatch)).toContain(
        "tonys-angels via delegated first-class-agent boundary runtime not ready for dispatch",
      );
      const task = getOperatorTask("task-dispatch-angela-stale-runtime");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("stale_runtime");
    });
  });

  it("blocks Angela dispatch when a 2xx response does not satisfy the expected contract", async () => {
    await withStateDirEnv("operator-dispatch-angela-invalid-contract-", async () => {
      const fetchMock = createHttpDelegateFetchMock({
        actionResponse: { message: "queued maybe" },
        actionStatus: 202,
        actionStatusText: "Accepted",
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_INTERNAL_CONTROL_URL: "http://angela.internal:18789",
        },
        async () =>
          await submitOperatorTaskAndDispatch({
            task_id: "task-dispatch-angela-invalid-contract",
            idempotency_key: "task-dispatch-angela-invalid-contract",
            requester: { id: "tonya", kind: "operator" },
            target: { capability: "marketing", team_id: "marketing" },
            objective: "Require a real Angela acknowledgment",
            tier: "STANDARD",
            acceptance_criteria: ["dispatch blocks"],
            timeout_s: 900,
          }),
      );

      expect(getDispatchMessage(result.dispatch)).toContain(
        "delegated transport response did not satisfy",
      );
      const task = getOperatorTask("task-dispatch-angela-invalid-contract");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("dispatch_failed");
    });
  });
});
