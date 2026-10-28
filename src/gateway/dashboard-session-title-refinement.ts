import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { sessionEntryCommitGuardOptions } from "../config/sessions/session-source-authority.js";
import type { SessionTitleRefinementState } from "../sessions/session-title-refinement-state.js";
import {
  countTitleRefinementMessage,
  resolveSessionTitleRefineConfig,
  resetTitlePrompt,
  initializeTitleRefinementState,
} from "../sessions/session-title-refinement-state.js";
import { resolveSessionTitleSource } from "../sessions/session-title-source.js";
import {
  prepareTitleSkillCommands,
  generateDashboardSessionTitle,
  type SessionTitleParams,
} from "./dashboard-session-title.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { readSessionTitleFieldsFromTranscriptAsync } from "./session-transcript-title-reader.js";

/**
 * Opt-in one-time refinement of an already generated title after several later
 * task messages. Never touches explicit labels (the same persist guard that
 * protects first titles also protects refinements) and runs at most once per
 * session generation (durable `titleRefinement` state, sessionId-bound).
 */
const SESSION_TITLE_REFINEMENT_PROMPT =
  "Generate a concise session title (3-6 words, max 60 characters) from the supplied conversation excerpt. Use the language the excerpt is written in, not the language of quoted literals, in sentence case: capitalize only the first word and words that language always capitalizes. No emoji. Return only the title.";

export async function maybeRefineDashboardSessionTitle(params: SessionTitleParams): Promise<void> {
  const sessionKey = resolveStoredSessionKeyForAgentStore(params);
  const scope = { agentId: params.agentId, sessionKey, storePath: params.storePath };
  const assertCurrent = () => params.commitGuard?.();
  const memory = captureSessionActorStorageOwner(scope, {
    assertCurrent,
    authorize: assertCurrent,
  });
  if (memory && !memory.owner?.readSession(sessionKey, memory.authority)?.entry) {
    return;
  }
  const assertMemorySessionCurrent = memory?.owner?.captureSessionReadGuard(sessionKey);
  const assertMemoryCurrent = () => {
    assertMemorySessionCurrent?.();
    memory?.binding?.actor.assertReadable();
    memory?.authority.assertCurrent();
  };
  try {
    const entry = await readSessionEntryReadOnlyInWorker(scope, assertMemoryCurrent);
    if (!entry || entry.incognito || entry.sessionId !== params.sessionId) {
      return;
    }
    // Manual titles are never refined; only generated displayName candidates.
    // Device/platform autoLabel metadata is NOT a manual name (the initial
    // title path ignores it too), so it must not block refinement eligibility.
    if (entry.label?.trim() || !entry.displayName?.trim()) {
      return;
    }
    const generatedName = entry.displayName.trim();
    const priorState = entry.titleRefinement;
    const refineConfig = resolveSessionTitleRefineConfig({ cfgSession: params.cfg.session });
    const resetMode = priorState?.resetMode;
    const lifecycleRevision = entry.lifecycleRevision;
    if (!refineConfig.enabled && !resetMode) {
      // Consume a pre-generated title's opening-turn marker even while
      // refinement is disabled: a marker that survives until the feature is
      // enabled would discard the first post-enable task as a repeat of the
      // opening turn and fire every threshold one message late
      // (Codex 4305281873). Only a real task turn consumes it, so control-only
      // messages still leave the marker armed.
      if (
        !priorState?.skipNextMessage ||
        priorState.refinementDone ||
        priorState.sessionId !== params.sessionId ||
        priorState.generatedName !== generatedName
      ) {
        return;
      }
      const skillCommands = await prepareTitleSkillCommands({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
        sessionKey,
        assertCurrent: assertMemoryCurrent,
      });
      const source =
        resolveSessionTitleSource(params.currentUserMessage ?? "", skillCommands) ??
        resolveSessionTitleSource(params.userMessage, skillCommands);
      if (!source) {
        return;
      }
      await patchSessionEntryCore(
        scope,
        (current) => {
          if (
            current.sessionId !== params.sessionId ||
            current.lifecycleRevision !== lifecycleRevision ||
            current.label?.trim() ||
            current.displayName?.trim() !== generatedName ||
            !current.titleRefinement ||
            current.titleRefinement.sessionId !== params.sessionId ||
            current.titleRefinement.generatedName !== generatedName ||
            current.titleRefinement.refinementDone ||
            !current.titleRefinement.skipNextMessage
          ) {
            return null;
          }
          return { titleRefinement: { ...current.titleRefinement, skipNextMessage: false } };
        },
        {
          requireWriteSuccess: false,
          ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
        },
      );
      return;
    }
    // Only real task turns advance the threshold: control-only slash messages
    // (e.g. /status, /model with no args) resolve to no source and don't count.
    let currentSource: string | null;
    {
      const skillCommands = await prepareTitleSkillCommands({
        cfg: params.cfg,
        agentId: params.agentId,
        entry,
        sessionKey,
        assertCurrent: assertMemoryCurrent,
      });
      currentSource =
        resolveSessionTitleSource(params.currentUserMessage ?? "", skillCommands) ??
        resolveSessionTitleSource(params.userMessage, skillCommands);
      if (!currentSource) {
        return;
      }
    }
    // Provenance: only names the automatic title writer marked (via
    // initializeTitleRefinementState) may be refined. A displayName that
    // exists without this state was set explicitly by the user/operator and
    // must never be adopted as a generated name.
    if (
      !priorState ||
      priorState.sessionId !== params.sessionId ||
      priorState.generatedName !== generatedName
    ) {
      return;
    }
    // Exactly-once: a completed refinement never counts or writes again.
    if (priorState.refinementDone) {
      return;
    }
    // Atomic claim: each job computes its increment INSIDE the entry-guarded
    // patch from the persisted state, so overlapping background turns
    // serialise without losing counter increments; exactly one caller sees
    // the claim succeed on the turn that reaches afterMessages.
    let claimed = false;
    let claimedState: SessionTitleRefinementState | undefined;
    await patchSessionEntryCore(
      scope,
      (current) => {
        if (
          current.sessionId !== params.sessionId ||
          current.lifecycleRevision !== lifecycleRevision ||
          current.incognito ||
          current.label?.trim() ||
          current.displayName?.trim() !== generatedName
        ) {
          return null;
        }
        const currentPrior = current.titleRefinement;
        // Provenance must persist into the claim: no state, or state from a
        // different session/name, means the name is not writer-owned.
        if (
          !currentPrior ||
          currentPrior.refinementDone ||
          currentPrior.generatedName !== generatedName ||
          currentPrior.sessionId !== params.sessionId
        ) {
          return null;
        }
        if (currentPrior.skipNextMessage) {
          return { titleRefinement: { ...currentPrior, skipNextMessage: false } };
        }
        const nextState = countTitleRefinementMessage(
          current.titleRefinement,
          params.sessionId,
          generatedName,
          currentSource,
        );
        // Below threshold: persist the counter only; the claim (and inference)
        // happens on the turn that reaches afterMessages.
        if (!resetMode && nextState.taskMessagesSinceTitle < refineConfig.afterMessages) {
          return { titleRefinement: nextState };
        }
        claimed = true;
        claimedState = nextState;
        // Consume the one allowed attempt in the same guarded write that
        // reaches the threshold; a concurrent turn cannot start another call.
        return {
          titleRefinement: {
            taskMessagesSinceTitle: nextState.taskMessagesSinceTitle,
            refinementDone: true,
            sessionId: nextState.sessionId,
            generatedName,
            lifecycleRevision,
          },
        };
      },
      {
        requireWriteSuccess: false,
        ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
      },
    );
    if (!claimed || !claimedState) {
      return;
    }
    const claimedTitleRefinement = claimedState;
    const skillCommands = await prepareTitleSkillCommands({
      cfg: params.cfg,
      agentId: params.agentId,
      entry,
      sessionKey,
      assertCurrent: assertMemoryCurrent,
    });
    const transcriptScope = {
      agentId: params.agentId,
      sessionEntry: entry,
      sessionId: params.sessionId,
      sessionKey,
      storePath: params.storePath,
    };
    const fields = await readSessionTitleFieldsFromTranscriptAsync(transcriptScope, {
      skillCommands,
    });
    assertMemoryCurrent();
    // Later task sources were captured by the entry writer, including turns
    // that have not yet reached the transcript reader.
    const sourceText = resetMode
      ? currentSource
      : [
          fields.firstUserMessage ?? "",
          ...(claimedTitleRefinement.recentMessages?.length
            ? claimedTitleRefinement.recentMessages
            : [fields.lastMessagePreview ?? "", currentSource ?? ""]),
        ]
          .filter(Boolean)
          .join("\n---\n")
          .trim();
    if (!sourceText) {
      return;
    }
    // Refinement keeps the current title on failure. Primary is allowed when
    // selected in the utility chain or when no utility is configured, never
    // appended as recovery from a failed utility chain.
    const refined = await generateDashboardSessionTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      entry: params.entry ?? entry,
      sourceText,
      promptOverride: resetMode
        ? resetTitlePrompt(resetMode, generatedName)
        : SESSION_TITLE_REFINEMENT_PROMPT,
      mode: "refinement",
      operatorAuthority: params.operatorAuthority,
      ...(memory ? { assertCurrent: assertMemoryCurrent } : {}),
      // A single-concurrency/local model queues the refinement behind the
      // overlapping reply; retry once after that turn settles instead of
      // burning the durable attempt on a 15-second timeout (Codex 4304532543).
      ...(params.retryAfter ? { retryAfter: params.retryAfter } : {}),
    });
    if (!refined || (!resetMode && refined === generatedName)) {
      return;
    }
    let persisted = false;
    await patchSessionEntryCore(
      scope,
      (current) => {
        if (
          current.sessionId !== params.sessionId ||
          current.lifecycleRevision !== lifecycleRevision ||
          current.label?.trim() ||
          current.displayName?.trim() !== generatedName ||
          current.titleRefinement?.generatedName !== generatedName ||
          !current.titleRefinement.refinementDone ||
          current.titleRefinement.taskMessagesSinceTitle !==
            claimedTitleRefinement.taskMessagesSinceTitle
        ) {
          return null;
        }
        persisted = true;
        return {
          displayName: refined,
          titleRefinement: resetMode
            ? { ...initializeTitleRefinementState(params.sessionId, refined), lifecycleRevision }
            : {
                lifecycleRevision,
                taskMessagesSinceTitle: claimedTitleRefinement.taskMessagesSinceTitle,
                refinementDone: true,
                sessionId: params.sessionId,
                generatedName: refined,
              },
        };
      },
      {
        requireWriteSuccess: true,
        ...sessionEntryCommitGuardOptions(assertMemoryCurrent),
      },
    );
    if (persisted) {
      params.onTitleStateChanged?.();
    }
  } catch {
    // Refinement is optional; it must never fail a chat send. The attempt was
    // already claimed atomically before inference, so no retry loop exists.
  }
}
