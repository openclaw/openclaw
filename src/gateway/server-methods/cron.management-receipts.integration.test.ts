import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { bindCronManagementGrant } from "../../agents/cron-creator-authority-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import * as historyReader from "../../cron/store/read-only.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { createHistoryJob, historyRecord, persistRuns } from "./cron-read.test-support.js";
import {
  admission,
  cfg,
  cron,
  createCronFixture,
  inRun,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";
import type { RespondFn } from "./types.js";

installRequesterCronAuthorityTestHooks();

it.for(["admin", "channel-owner", "non-owner"] as const)(
  "%s receipt disclosure through the Gateway router and persisted history",
  async (role, { signal }) => {
    const fixture = createCronFixture();
    const job = await cron.add(createHistoryJob("main", "agent:main:foreign-conversation"));
    const entry = {
      action: "finished" as const,
      jobId: job.id,
      runId: "recorded-run",
      status: "ok" as const,
      ts: 100,
      summary: "Synthetic private receipt",
    };
    persistRuns([historyRecord(entry, fixture.context.cronStorePath, "main", "recorded-run")]);
    setRuntimeConfigSnapshot({ ...cfg, commands: { ownerAllowFrom: ["discord:owner-1"] } });
    const runId = `receipt-${role}`;
    const operator = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
    operator.internal = { controlUiAdmin: true };
    const admitted =
      role === "admin"
        ? admission(runId, operator)
        : role === "channel-owner"
          ? {
              runId,
              callerOrigin: { kind: "unknown" as const },
              managementEntitlement: {
                source: "channel-owner" as const,
                isCurrent: () =>
                  isConfiguredCommandOwner(getRuntimeConfig(), {
                    channel: "discord",
                    senderId: "owner-1",
                  }),
              },
            }
          : undefined;
    await inRun(runId, admitted, async (identity) => {
      const query = async (method: "cron.get" | "cron.runs") => {
        const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
        client.internal!.agentRuntimeIdentity = {
          ...identity,
          cronManagementGrant: bindCronManagementGrant(runId)?.mint(method),
        };
        const respond = vi.fn<RespondFn>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: method,
            method,
            params: { id: job.id, ...(method === "cron.runs" ? { runId: entry.runId } : {}) },
          },
          client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => false,
        });
        expect(respond).toHaveBeenCalledTimes(1);
        return expectDefined(respond.mock.calls[0], "Gateway response");
      };
      for (const method of ["cron.get", "cron.runs"] as const) {
        const [ok, result, error] = await query(method);
        if (role === "non-owner") {
          expect(ok).toBe(false);
          expect(result).toBeUndefined();
          expect(error?.message).toContain("not found");
        } else {
          expect(ok).toBe(true);
          expect(error).toBeUndefined();
          expect(result).toMatchObject(
            method === "cron.get" ? { id: job.id } : { total: 1, entries: [entry] },
          );
        }
      }
      if (role !== "channel-owner") {
        return;
      }
      const entered = createDeferred();
      const release = createDeferred();
      const read = historyReader.readCronRunHistoryRecords;
      // Preserve real storage hydration, delaying only its return to the handler.
      const spy = vi
        .spyOn(historyReader, "readCronRunHistoryRecords")
        .mockImplementation(async (...args) => {
          const rows = await read(...args);
          expect(rows).toHaveLength(1);
          entered.resolve();
          await withinTest(release.promise, signal);
          return rows;
        });
      const pending = query("cron.runs");
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            pending,
            "Receipt returned before hydration gate",
          ),
          signal,
        );
        setRuntimeConfigSnapshot({ ...cfg, commands: { ownerAllowFrom: [] } });
        release.resolve();
        const [ok, result, error] = await pending;
        expect(ok).toBe(false);
        expect(result).toBeUndefined();
        expect(error?.message).toMatch(/authority|grant|owner/i);
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        spy.mockRestore();
      }
    });
  },
);
