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
import { withResolvedClawHubSource } from "./clawhub-source.js";
import type { ChatTemplateAddInput } from "./gateway-add-input.js";
import type { GatewayTemplateAddApplyResult } from "./gateway-add-result.js";
import { finishTemplateDependencies } from "./setup-dependencies.js";
import type { TemplateReadResult } from "./types.js";

/** The ordinary session owns this one-shot continuation, not an installed Template ledger. */
export async function continueTemplateSetup(
  input: ChatTemplateAddInput,
  agentIdInput: string,
  stateContext: OpenClawStateWorkerContext,
  preparedSource?: Extract<TemplateReadResult, { ok: true }>,
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
  const pendingSetup = entry?.templateSetup;
  let report = pendingSetup?.report;
  if (!entry) {
    if (input.resume) {
      throw new Error(
        "The Template conversation no longer exists; Retry cannot create another agent.",
      );
    }
    return undefined;
  }
  const result = (
    openingError?: string,
    code = "template_opening_failed",
  ): GatewayTemplateAddApplyResult => {
    const error = openingError
      ? { code, message: openingError }
      : report?.failures.length
        ? {
            code: "template_setup_incomplete",
            message:
              "Some Template dependencies could not be set up. The agent and conversation were kept. Continue in this chat; do not add another copy.",
          }
        : !report
          ? {
              code: "template_setup_outcome_unavailable",
              message:
                "Template setup has finished, but Retry cannot verify its dependency outcome. Continue in the existing chat; no setup was repeated.",
            }
          : undefined;
    return {
      agentId,
      sessionKey,
      status: error ? "partial" : "complete",
      readiness: { ready: !error, requirements: [] },
      ...(error ? { agentRetained: true, error } : {}),
      ...(openingError ? { initializationPending: true } : {}),
    };
  };
  if (!pendingSetup) {
    // A stale Retry can outlive the consumed setup receipt. Reconcile the
    // existing conversation instead of falling through to a fresh Add.
    return input.resume && !entry.initializationPending ? result() : undefined;
  }
  let setup = pendingSetup;
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
        const currentEntry = await readSessionEntryReadOnlyInWorker(scope, assertCurrent);
        if (currentEntry?.sessionId !== entry.sessionId) {
          throw new Error("The Template conversation changed before setup; it was left intact.");
        }
        if (!currentEntry.templateSetup) {
          // The consumed receipt cannot prove success, even if our pre-lease report was empty.
          report = undefined;
          return result();
        }
        if (!isDeepStrictEqual(currentEntry.templateSetup, setup)) {
          throw new Error("The Template setup continuation changed; it was left intact.");
        }
        const agent = { agentId, sessionKey };
        // One ordinary session receipt owns both branches. Keep its agent lease until
        // installation and the source turn settle; Retry cannot duplicate live work.
        let checkpoints = Promise.resolve();
        const save = (update: (current: typeof setup) => typeof setup) => {
          const saved = checkpoints.then(async () => {
            const expected = setup;
            const next = update(setup);
            await patchSessionEntryCore(
              scope,
              (latest) => {
                assertCurrent();
                if (
                  latest?.sessionId !== entry.sessionId ||
                  !isDeepStrictEqual(latest.templateSetup, expected)
                ) {
                  throw new Error("The Template setup continuation changed before checkpointing.");
                }
                return { templateSetup: next };
              },
              {
                preserveActivity: true,
                requireWriteSuccess: true,
                ...sessionEntryCommitGuardOptions(assertCurrent),
              },
            );
            setup = next;
            report = next.report;
          });
          checkpoints = saved;
          return saved;
        };
        // An absent inventory on an older receipt is not an empty manifest. Bind the
        // exact release once; a later edit to the agent's CLAW.md cannot remove required work.
        let required = setup.requiredAutomationIds;
        if (!required) {
          if (!setup.source.version) {
            throw new Error(
              "Cannot verify required automations without an exact Template version.",
            );
          }
          const { value: requiredAutomationIds } = await withResolvedClawHubSource({
            ...input,
            coordinate: setup.source,
            mode: "preview",
            run: async (source) => source.manifest.automations.map(({ id }) => id),
          });
          await save((current) => ({ ...current, requiredAutomationIds }));
          required = requiredAutomationIds;
        }
        const missingAutomations = async () => {
          if (!required.length) {
            return [];
          }
          if (!input.readSetupAutomationKeys) {
            throw new Error(
              "The scheduler is unavailable to verify the Template's required automations.",
            );
          }
          const keys = await input.readSetupAutomationKeys(agent);
          assertCurrent();
          return required.filter((id) => !keys.has(`template:${agentId}:${id}`));
        };
        if (setup.openingComplete && (await missingAutomations()).length) {
          // A resumed checkpoint (including one from an older Gateway) is not a scheduler receipt.
          await save(({ openingComplete: _complete, ...current }) => current);
        }
        const runOpening = async (onModelRequested?: () => void) => {
          try {
            await input.onAgentCreated?.(agent, setup, onModelRequested);
          } finally {
            onModelRequested?.();
          }
          // Record the settled turn. The scheduler, not its visible reply, proves completion below.
          await save((current) => ({ ...current, openingComplete: true }));
        };
        const openingIncludesReport = !setup.dependenciesPending && !setup.openingComplete;
        if (setup.dependenciesPending) {
          const install = async () => {
            const workspace = config.agents!.entries![agentId]!.workspace!;
            const run = (source: Extract<TemplateReadResult, { ok: true }>) =>
              finishTemplateDependencies(source, input, agentId, workspace, stateContext, lease);
            if (preparedSource) {
              return await run(preparedSource);
            }
            const resolved = await withResolvedClawHubSource({
              ...input,
              coordinate: input.source,
              mode: "apply",
              run: async (source) => await run(source),
            });
            return resolved.value;
          };
          // The user is waiting for the greeting. Preparing the opening turn and installing
          // dependencies both contend for the Gateway's main thread, so installation starts
          // once that turn has sent its first model request, or has ended without one.
          const openingRequested = Promise.withResolvers<void>();
          const [opening, dependencies] = await Promise.allSettled([
            setup.openingComplete ? Promise.resolve() : runOpening(openingRequested.resolve),
            (async () => {
              if (!setup.openingComplete) {
                await openingRequested.promise;
              }
              const installed = await install();
              await save((current) => {
                const { dependenciesPending: _pending, ...settled } = current;
                return { ...settled, report: installed };
              });
            })(),
          ]);
          if (dependencies.status === "rejected") {
            throw dependencies.reason;
          }
          if (opening.status === "rejected") {
            throw opening.reason;
          }
        }
        assertCurrent();
        if (!setup.openingComplete) {
          // A failed first turn retries with the settled report, without reinstalling anything.
          await runOpening();
        }
        if (
          !openingIncludesReport &&
          (setup.report.failures.length || setup.report.mcpServers.length)
        ) {
          await input.onDependenciesSettled?.(agent, setup.report);
        }
        const missing = await missingAutomations();
        if (missing.length) {
          await save(({ openingComplete: _complete, ...current }) => current);
          return result(
            `Template setup is missing required automations (${missing.slice(0, 3).join(", ")}). Retry setup in this chat; existing jobs are kept.`,
            "template_automations_incomplete",
          );
        }
        const completed = setup;
        await patchSessionEntryCore(
          scope,
          (latest) => {
            assertCurrent();
            if (
              latest?.sessionId !== entry.sessionId ||
              !isDeepStrictEqual(latest.templateSetup, completed)
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
