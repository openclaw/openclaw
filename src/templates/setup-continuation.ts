import { isDeepStrictEqual } from "node:util";
import { coerceErrorMessage } from "@openclaw/normalization-core";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import type { GatewayTemplateAddApplyResult } from "./gateway-add-apply.js";
import type { ChatTemplateAddInput } from "./gateway-add-chat.js";

/** The ordinary session owns this one-shot continuation, not an installed Template ledger. */
export async function continueTemplateSetup(
  input: ChatTemplateAddInput,
  agentIdInput: string,
  stateContext: OpenClawStateWorkerContext,
): Promise<GatewayTemplateAddApplyResult | undefined> {
  const agentId = normalizeAgentId(agentIdInput);
  const config = (await input.getPlanningContext()).config;
  if (!config.agents?.entries?.[agentId]) {
    if (input.resume) {
      throw new Error("The Template agent no longer exists; Retry cannot create another agent.");
    }
    return undefined;
  }
  const sessionKey = resolveAgentMainSessionKey({ cfg: config, agentId });
  const scope = {
    agentId,
    sessionKey,
    storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
  };
  const entry = await readSessionEntryReadOnlyInWorker(scope, input.assertCurrent);
  const setup = entry?.templateSetup;
  if (!entry) {
    if (input.resume) {
      throw new Error(
        "The Template conversation no longer exists; Retry cannot create another agent.",
      );
    }
    return undefined;
  }
  const result = (error?: string): GatewayTemplateAddApplyResult => ({
    agentId,
    sessionKey,
    status: error ? "partial" : "complete",
    readiness: { ready: !error && !setup?.report.failures.length, requirements: [] },
    ...(error
      ? {
          agentRetained: true,
          initializationPending: true,
          error: { code: "template_opening_failed", message: error },
        }
      : {}),
  });
  if (!setup) {
    // A stale Retry can outlive the consumed setup receipt. Reconcile the
    // existing conversation instead of falling through to a fresh Add.
    return input.resume && !entry.initializationPending ? result() : undefined;
  }
  if (!isDeepStrictEqual(setup.source, input.source)) {
    if (input.resume) {
      throw new Error("The Template setup source changed; Retry left the agent intact.");
    }
    return undefined;
  }
  try {
    // Hold the existing agent lease through source completion. A concurrent Retry
    // cannot start another setup while the first still owns tools or publication.
    return await withOpenClawStateLeaseAsync(
      {
        scope: "core:agent-deletion",
        key: agentId,
        leaseMs: 60_000,
        waitMs: 5_000,
        heartbeat: "worker",
        signal: input.signal,
        leaseLabel: "Template setup",
        operationLabel: "template.setup",
      },
      stateContext,
      async (lease) => {
        const assertCurrent = () => {
          input.assertCurrent();
          lease.assertCurrent();
        };
        const current = await readSessionEntryReadOnlyInWorker(scope, assertCurrent);
        if (current?.sessionId !== entry.sessionId) {
          throw new Error("The Template conversation changed before setup; it was left intact.");
        }
        if (!current.templateSetup) {
          return result(); // Another admitted Retry already completed this continuation.
        }
        if (!isDeepStrictEqual(current.templateSetup, setup)) {
          throw new Error("The Template setup continuation changed; it was left intact.");
        }
        assertCurrent();
        await input.onAgentCreated?.({ agentId, sessionKey }, setup.report);
        await patchSessionEntryCore(
          scope,
          (latest) => {
            assertCurrent();
            if (
              latest?.sessionId !== entry.sessionId ||
              !isDeepStrictEqual(latest.templateSetup, setup)
            ) {
              throw new Error("The Template setup continuation changed before completion.");
            }
            return { templateSetup: undefined };
          },
          {
            preserveActivity: true,
            requireWriteSuccess: true,
            ...sessionEntryCommitGuardOptions(assertCurrent),
          },
        );
        return result();
      },
    );
  } catch (error) {
    return result(coerceErrorMessage(error));
  }
}
