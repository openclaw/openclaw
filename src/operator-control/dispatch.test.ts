import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnvAsync } from "../test-utils/env.js";
import { dispatchOperatorTask, submitOperatorTaskAndDispatch } from "./dispatch.js";
import { getOperatorTask, submitOperatorTask } from "./task-store.js";

describe("operator task dispatch", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("submits and dispatches operator tasks to 2Tony when configured", async () => {
    await withStateDirEnv("operator-dispatch-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        json: async () => ({
          taskId: "task-dispatch-1",
          status: "accepted",
          runId: "task-run-dispatch-1",
        }),
      });
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
          }),
      );

      expect(result.created).toBe(true);
      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: true,
        endpoint: "http://2tony.internal:3009/task",
        statusCode: 202,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        json: async () => ({
          taskId: "task-dispatch-2tony-no-secret",
          status: "accepted",
          runId: "task-run-dispatch-2tony-no-secret",
        }),
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
          }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });

  it("infers a concrete 2Tony task type from operator inputs", async () => {
    await withStateDirEnv("operator-dispatch-2tony-infer-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        json: async () => ({
          taskId: "task-dispatch-infer",
          status: "accepted",
          runId: "task-run-dispatch-infer",
        }),
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
          }),
      );

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
          }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.dispatch).toMatchObject({
        attempted: true,
        accepted: false,
        endpoint: "http://2tony.internal:3009/task",
        statusCode: 0,
      });
      expect(result.dispatch.message).toContain("could not be inferred");
      const task = getOperatorTask("task-dispatch-unmappable");
      expect(task?.receipt.state).toBe("blocked");
      expect(task?.receipt.failure_code).toBe("dispatch-failed");
    });
  });

  it("dispatches project-ops tasks to Deb when team routing selects deb-http", async () => {
    await withStateDirEnv("operator-dispatch-deb-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
          output: "Deb Board Status",
        }),
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
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    });
  });

  it("sends the Deb shared secret when configured", async () => {
    await withStateDirEnv("operator-dispatch-deb-secret-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          ok: true,
        }),
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

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer top-secret-deb");
    });
  });

  it("dispatches marketing tasks to Angela when team routing selects angela-http", async () => {
    await withStateDirEnv("operator-dispatch-angela-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        json: async () => ({
          status: "accepted",
          message: "Angela queued campaign request",
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const result = await withEnvAsync(
        {
          OPENCLAW_OPERATOR_ANGELA_URL: "http://angela.internal:18789",
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
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
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
      });
      const task = getOperatorTask("task-dispatch-4");
      expect(task?.receipt.state).toBe("queued");
      expect(task?.receipt.owner).toBe("angela");
      expect(task?.envelope.execution.transport).toBe("angela-http");
    });
  });

  it("sends the Angela shared secret when configured", async () => {
    await withStateDirEnv("operator-dispatch-angela-secret-", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        statusText: "Accepted",
        json: async () => ({
          status: "accepted",
        }),
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await withEnvAsync(
        {
          OPENCLAW_OPERATOR_ANGELA_URL: "http://angela.internal:18789",
          OPENCLAW_OPERATOR_ANGELA_SHARED_SECRET: "top-secret-angela",
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

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).authorization).toBe(
        "Bearer top-secret-angela",
      );
    });
  });
});
