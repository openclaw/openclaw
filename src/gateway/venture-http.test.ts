import { describe, expect, it } from "vitest";
import { getFreePort, installGatewayTestHooks, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function postJson(params: {
  port: number;
  path: string;
  body: Record<string, unknown>;
  authToken?: string;
}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (params.authToken) {
    headers.authorization = `Bearer ${params.authToken}`;
  }
  return await fetch(`http://127.0.0.1:${params.port}${params.path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(params.body),
  });
}

async function pollStatus(params: {
  port: number;
  token: string;
  jobId: string;
  timeoutMs?: number;
}) {
  const deadline = Date.now() + (params.timeoutMs ?? 8_000);
  while (Date.now() < deadline) {
    const res = await postJson({
      port: params.port,
      path: "/v1/venture/jobs/status",
      authToken: params.token,
      body: { jobId: params.jobId },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ok: boolean;
      job?: { status?: string };
    };
    expect(json.ok).toBe(true);
    const status = json.job?.status;
    if (status === "succeeded" || status === "failed") {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timeout waiting for terminal venture job status");
}

describe("venture HTTP endpoints", () => {
  it("requires auth for enqueue endpoint", async () => {
    await withGatewayServer(
      async ({ port }) => {
        const res = await postJson({
          port,
          path: "/v1/venture/jobs",
          body: { moduleId: "market-intelligence", input: { query: "ai", signals: [] } },
        });
        expect(res.status).toBe(401);
      },
      {
        port: await getFreePort(),
        serverOptions: {
          host: "127.0.0.1",
          auth: { mode: "token", token: "secret" },
          controlUiEnabled: false,
        },
      },
    );
  });

  it("validates required moduleId", async () => {
    await withGatewayServer(
      async ({ port }) => {
        const res = await postJson({
          port,
          path: "/v1/venture/jobs",
          authToken: "secret",
          body: { input: { query: "missing module id" } },
        });
        expect(res.status).toBe(400);
        const json = (await res.json()) as { ok: boolean; error?: string };
        expect(json.ok).toBe(false);
        expect(json.error).toBe("moduleId is required");
      },
      {
        port: await getFreePort(),
        serverOptions: {
          host: "127.0.0.1",
          auth: { mode: "token", token: "secret" },
          controlUiEnabled: false,
        },
      },
    );
  });

  it("enqueues and executes market-intelligence module", async () => {
    await withGatewayServer(
      async ({ port }) => {
        const enqueue = await postJson({
          port,
          path: "/v1/venture/jobs",
          authToken: "secret",
          body: {
            moduleId: "market-intelligence",
            input: {
              query: "local services automation",
              signals: [
                {
                  source: "manual",
                  topic: "AI lead gen for local SMB",
                  momentum: 0.8,
                  pain: 0.9,
                  monetization: 0.7,
                },
              ],
            },
            priority: "high",
          },
        });
        expect(enqueue.status).toBe(202);
        const queued = (await enqueue.json()) as {
          ok: boolean;
          job: { id: string; status: string; moduleId: string };
        };
        expect(queued.ok).toBe(true);
        expect(queued.job.moduleId).toBe("market-intelligence");
        expect(queued.job.status).toBe("queued");

        const status = await pollStatus({ port, token: "secret", jobId: queued.job.id });
        expect(status).toBe("succeeded");
      },
      {
        port: await getFreePort(),
        serverOptions: {
          host: "127.0.0.1",
          auth: { mode: "token", token: "secret" },
          controlUiEnabled: false,
        },
      },
    );
  });

  it("deduplicates enqueue by dedupeKey", async () => {
    await withGatewayServer(
      async ({ port }) => {
        const body = {
          moduleId: "funnel-builder",
          input: {
            offerName: "AI Ops Ebook",
            audience: "coaches",
            channel: "web",
            goal: "checkout",
            hasUpsell: true,
          },
          dedupeKey: "funnel:ai-ops-ebook:v1",
        };
        const first = await postJson({
          port,
          path: "/v1/venture/jobs",
          authToken: "secret",
          body,
        });
        expect(first.status).toBe(202);
        const firstJson = (await first.json()) as { job: { id: string } };

        const second = await postJson({
          port,
          path: "/v1/venture/jobs",
          authToken: "secret",
          body,
        });
        expect(second.status).toBe(200);
        const secondJson = (await second.json()) as {
          ok: boolean;
          deduped?: boolean;
          job: { id: string };
        };
        expect(secondJson.ok).toBe(true);
        expect(secondJson.deduped).toBe(true);
        expect(secondJson.job.id).toBe(firstJson.job.id);
      },
      {
        port: await getFreePort(),
        serverOptions: {
          host: "127.0.0.1",
          auth: { mode: "token", token: "secret" },
          controlUiEnabled: false,
        },
      },
    );
  });
});

