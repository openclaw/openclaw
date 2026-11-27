import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../packages/gateway-protocol/src/client-info.js";
import type { EventFrame } from "../packages/gateway-protocol/src/frame-guards.js";
import type { CronJob } from "../packages/gateway-protocol/src/schema/cron.types.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { connectRestartClient } from "./gateway-restart.test-support.js";
import type { OpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

export function createScheduledRestartConnector(
  instance: OpenClawTestInstance,
  sessionKey: string,
  commandPrefix: string,
) {
  const deviceIdentity = loadOrCreateDeviceIdentity({
    path: instance.state.path("scheduled-restart-device", "client", "credentials.sqlite"),
  });
  return async () => {
    const events: EventFrame[] = [];
    // Reconnect as the same paired chat requester whose authority each occurrence restores.
    const client = await connectRestartClient(instance, {
      deviceIdentity,
      clientName: GATEWAY_CLIENT_IDS.TUI,
      mode: GATEWAY_CLIENT_MODES.UI,
      onEvent: (event) => events.push(event),
    });
    const schedule = async (label: string) => {
      const runId = randomUUID();
      await client.request("chat.send", {
        sessionKey,
        message: commandPrefix + " " + label,
        deliver: false,
        idempotencyKey: runId,
      });
      let text: string | undefined;
      await vi.waitFor(
        () => {
          const final = events.find((event) => {
            const payload = event.payload as { runId?: string; state?: string } | undefined;
            return event.event === "chat" && payload?.runId === runId && payload.state === "final";
          });
          text = extractFirstTextBlock((final?.payload as { message?: unknown })?.message);
          expect(text, instance.logs()).toMatch(/^SCHEDULED \S+ true$/);
        },
        { timeout: 60_000, interval: 50 },
      );
      return text!.split(" ")[1]!;
    };
    const jobs = async () =>
      (
        await client.request<{ jobs: CronJob[] }>("cron.list", {
          includeDisabled: true,
          limit: 200,
        })
      ).jobs;
    const job = async (id: string) => (await jobs()).find((entry) => entry.id === id);
    return { client, schedule, jobs, job };
  };
}
