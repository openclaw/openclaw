import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../packages/gateway-client/src/protocol-request.js";
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { digestClawValue } from "../claws/digest.js";
import { buildClawRemovalFixture } from "../claws/lifecycle-remove.test-support.js";
import { persistClawInstallRecord } from "../claws/provenance.js";
import { clawRemovalJournalResultSchema } from "../claws/removal-journal-contract.js";
import { clawRemovalJournalGateway } from "../cli/claws-cli.removal-journal.js";
import * as gatewayRpc from "../cli/gateway-rpc.js";
import { getRuntimeConfig, resetConfigRuntimeState } from "../config/config.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { AgentDeletionJournalTransport } from "../state/agent-deletion-journal-transport.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { readOpenClawStateLease } from "../state/openclaw-state-lease-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clawsRemovalJournalHandlers } from "./server-methods/claws-removal-journal.js";

afterEach(() => vi.restoreAllMocks());

describe("Gateway-owned Claw removal journal", () => {
  it.each(["acknowledged", "lost-reply", "stale-install", "revoked-request"] as const)(
    "preserves journal and lease custody for %s",
    async (scenario) => {
      await withOpenClawTestState({ label: `claw-journal-${scenario}` }, async (state) => {
        const { plan } = await buildClawRemovalFixture(state.root);
        await state.writeConfig({
          agents: { entries: { worker: { workspace: plan.agent.workspace } } },
        });
        resetConfigRuntimeState();
        const install = persistClawInstallRecord(plan);
        const config = getRuntimeConfig();
        const phases: string[] = [];
        let committedOperation: string | undefined;
        vi.spyOn(gatewayRpc, "callGatewayFromCli").mockImplementation(
          async (method, _opts, params, extra) => {
            expect(method).toBe("claws.removalJournal");
            // Only the transport is substituted; the journal worker and both live owners are real.
            if (
              !params ||
              typeof params !== "object" ||
              !("phase" in params) ||
              !("agentId" in params)
            ) {
              throw new Error("Missing synthetic transport request");
            }
            let response: unknown;
            let failure: ErrorShape | undefined;
            await clawsRemovalJournalHandlers["claws.removalJournal"]({
              params: { ...params },
              context: {
                cronStorePath: resolveCronJobsStorePathFromConfig(config),
                getRuntimeConfig: () => config,
                isConfigReloadSettled: () => true,
              },
              signal: extra?.signal,
              hasCurrentClientAuthority: () => scenario !== "revoked-request",
              respond: (accepted, payload, error) => {
                response = payload;
                failure = accepted ? undefined : error;
              },
            });
            if (failure) {
              const error = new GatewayProtocolRequestError(failure);
              retainGatewayResponsePayload(error, response);
              throw error;
            }
            if (scenario === "lost-reply") {
              committedOperation = readAgentDeletionJournal("worker")?.operationId;
              expect(committedOperation).toBeTruthy();
              throw new Error("Synthetic connection lost after the native journal commit");
            }
            return clawRemovalJournalResultSchema.parse(response);
          },
        );
        const journalTransport: AgentDeletionJournalTransport = (mutation, authority) => {
          phases.push(mutation.kind);
          return clawRemovalJournalGateway(
            {
              ...mutation,
              expectedInstallDigest: digestClawValue(scenario === "stale-install" ? null : install),
              configDigest: digestClawValue(config),
            },
            authority,
          );
        };
        const removal = withAgentDeletion(
          "worker",
          async (begin) => {
            const deletion = await begin({
              agentId: "worker",
              agentDir: state.agentDir("worker"),
              workspaceDir: plan.agent.workspace,
              sessionsDir: state.sessionsDir("worker"),
              deleteFiles: false,
            });
            expect(readAgentDeletionJournal("worker")).toMatchObject({
              operationId: deletion.entry.operationId,
              workspaceDir: plan.agent.workspace,
              cleanupCompleted: false,
            });
            deletion.assertCurrent();
            await deletion.rollback();
          },
          { journalTransport },
        );
        if (scenario === "acknowledged") {
          await removal;
          expect(phases).toEqual(["begin", "rollback"]);
        } else {
          await expect(removal).rejects.toThrow(
            scenario === "stale-install"
              ? /changed before mutation/
              : scenario === "revoked-request"
                ? /request authority/
                : /unknown/,
          );
          expect(phases).toEqual(["begin"]);
        }
        const journal = readAgentDeletionJournal("worker");
        const lease = readOpenClawStateLease(openOpenClawStateDatabase().db, {
          scope: "core:agent-deletion",
          key: "worker",
        });
        if (scenario === "lost-reply") {
          expect(journal).toMatchObject({
            operationId: committedOperation,
            cleanupCompleted: false,
          });
          expect(lease).toBeDefined();
        } else {
          expect(journal).toBeUndefined();
          expect(lease).toBeUndefined();
        }
      });
    },
  );
});
