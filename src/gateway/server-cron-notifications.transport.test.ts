// Real-transport proof: cron webhooks never read status/body, so they must
// cancel unread response bodies before release() or undici keeps the socket pinned.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.types.js";
import type { CronJob } from "../cron/types.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { sendGatewayCronFailureAlert } from "./server-cron-notifications.js";

vi.mock("../infra/net/fetch-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/net/fetch-guard.js")>();
  return {
    ...actual,
    // Production cron webhooks intentionally omit allowPrivateNetwork (SSRF).
    // Transport proof only needs a loopback half-open body, so loosen policy here
    // while still exercising the real fetch + production cancel/release path.
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      actual.fetchWithSsrFGuard({
        ...params,
        policy: {
          ...params.policy,
          allowPrivateNetwork: true,
        },
      }),
  };
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function createWebhookFailureJob(): CronJob {
  return {
    id: "cron-webhook-body-cancel",
    name: "webhook body cancel",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "webhook", to: "https://example.invalid/unused" },
    state: {},
  };
}

describe("postCronWebhook transport body cleanup", () => {
  afterEach(() => {
    resetGatewayWorkAdmission();
  });

  it("cancels unread failure-alert webhook bodies and closes the request socket", async () => {
    let resolveClientClosed: (() => void) | undefined;
    const clientClosed = new Promise<void>((resolve) => {
      resolveClientClosed = resolve;
    });
    const server = createServer((request, response) => {
      request.socket.once("close", () => resolveClientClosed?.());
      // Keep the body open: fire-and-forget webhooks must cancel rather than
      // wait for natural completion, or the connection stays pinned.
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"accepted":');
    });

    const webhookUrl = await listen(server);
    try {
      await sendGatewayCronFailureAlert({
        deps: {} as CliDeps,
        logger: { warn: vi.fn() },
        resolveCronAgent: () => ({ agentId: "main", cfg: {} }),
        job: createWebhookFailureJob(),
        text: "cron failed",
        channel: "last",
        mode: "webhook",
        to: webhookUrl,
      });

      await expect(clientClosed).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
