import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { GatewayCronState } from "./server-cron.js";
import type { GatewayClient } from "./server-methods/types.js";

export const CRON_WAIT_TIMEOUT_MS = 10_000;

export type DirectCronState = GatewayCronState & {
  getRuntimeConfig: () => import("../config/types.openclaw.js").OpenClawConfig;
};

export type CronBroadcast = (event: string, payload: unknown) => void;

type DirectCronResponse = {
  ok: boolean;
  payload?: unknown;
  error?: { code?: string; message?: string; details?: unknown };
};

export function createCronEventCollector() {
  const events: Record<string, unknown>[] = [];
  const waiters: Array<{
    check: (payload: Record<string, unknown>) => boolean;
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const flush = (payload: Record<string, unknown>) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter) {
        continue;
      }
      if (!waiter.check(payload)) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve(payload);
    }
  };
  return {
    broadcast: (event: string, payload: unknown) => {
      if (event !== "cron" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      events.push(record);
      flush(record);
    },
    wait(check: (payload: Record<string, unknown>) => boolean, timeoutMs = CRON_WAIT_TIMEOUT_MS) {
      const existing = events.find(check);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = {
          check,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error("timeout waiting for cron event"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

export async function directCronReq(
  cronState: DirectCronState,
  method: string,
  params: Record<string, unknown>,
  options: { client?: GatewayClient; sessionMutationCommitGuard?: () => void } = {},
): Promise<DirectCronResponse> {
  const { cronHandlers } = await import("./server-methods/cron.js");
  let result: DirectCronResponse | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: DirectCronResponse["error"]) => {
    result = { ok, payload, error };
  };
  try {
    await expectDefined(
      cronHandlers[method],
      "cronHandlers[method] test invariant",
    )({
      req: {} as never,
      params,
      respond,
      context: {
        cron: cronState.cron,
        cronStorePath: cronState.storePath,
        logGateway: createInfoWarnErrorLogger(),
        getRuntimeConfig: cronState.getRuntimeConfig,
      } as never,
      client: options.client ?? null,
      sessionMutationCommitGuard: options.sessionMutationCommitGuard,
      isWebchatConnect: () => false,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return expectDefined(result, `${method} did not respond`);
}

export function agentCronClient(
  sessionKey: string,
  options: { spawnContext?: boolean } = {},
): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef("run-cron-agent-creator");
  return {
    connect: {} as GatewayClient["connect"],
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "cron-agent-creator-generation",
          claimId: "cron-agent-creator-claim",
        },
        turnSourceAccountId: "default",
        ...(options.spawnContext
          ? {
              sessionSpawnContext: {
                inheritedToolPolicy: { version: 1, allow: ["*"], deny: [] },
              },
            }
          : {}),
      },
    },
  };
}

export function expectCronJobIdFromResponse(response: { ok?: unknown; payload?: unknown }) {
  expect(response.ok, JSON.stringify((response as { error?: unknown }).error ?? null)).toBe(true);
  const value = (response.payload as { id?: unknown } | null)?.id;
  const id = typeof value === "string" ? value : "";
  expect(id.length > 0).toBe(true);
  return id;
}
