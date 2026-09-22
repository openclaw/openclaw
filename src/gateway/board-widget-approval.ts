import { createHash } from "node:crypto";
import type { BoardWidgetMaterializedPutParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveExecDefaults } from "../agents/exec-defaults.js";
import { resolveRuntimeConfigCacheKey } from "../config/runtime-snapshot.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.entry.js";
import { readSessionEntriesFromStoreInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readExecApprovalsPolicyReadOnlyAsync } from "../infra/exec-approvals-store.js";
import { resolveExecAutoReviewDecision } from "../infra/exec-auto-review.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";

/** One bounded assessment cache per Board handler owner, never a cache of grant authority. */
export function createBoardWidgetApprovalResolver() {
  const approved = new Set<string>();
  let configRevision: string | undefined;
  let policyRevision: string | undefined;
  return async (params: {
    cfg: OpenClawConfig;
    agentId: string;
    sessionKey: string;
    name: string;
    content: BoardWidgetMaterializedPutParams["content"];
    declared: NonNullable<BoardWidgetMaterializedPutParams["declared"]>;
  }): Promise<"granted" | "rejected" | undefined> => {
    const { cfg, agentId, sessionKey, name, content, declared } = params;
    const currentConfigRevision = resolveRuntimeConfigCacheKey(cfg);
    const scope = { sessionKey, agentId };
    const incognito = isIncognitoSessionKey(sessionKey);
    const [policy, sessionEntry] = await Promise.all([
      readExecApprovalsPolicyReadOnlyAsync(),
      // Incognito state stays with its existing process-held SQLite owner.
      incognito
        ? loadSessionEntryReadOnly(scope)
        : readSessionEntriesFromStoreInWorker({
            agentId,
            storePath: resolveSessionStorePathForScope(scope, cfg),
            sessionKeys: [sessionKey],
          }).then(
            (sessions) => sessions.entries.find((entry) => entry.sessionKey === sessionKey)?.entry,
          ),
    ]);
    if (configRevision !== currentConfigRevision || policyRevision !== policy.revision) {
      approved.clear();
      configRevision = currentConfigRevision;
      policyRevision = policy.revision;
    }
    const mode = resolveExecDefaults({
      cfg,
      agentId,
      sessionKey,
      sessionEntry,
      execApprovals: policy.file,
    }).mode;
    if (mode === "ask") {
      return undefined;
    }
    if (mode !== "auto") {
      return mode === "full" ? "granted" : "rejected";
    }
    // MCP App interactions retain source-session authority and cannot share assessments.
    const key =
      !incognito && policy.revision && (content.kind === "html" || content.kind === "registered")
        ? createHash("sha256")
            .update(JSON.stringify([agentId, name, content, declared]))
            .digest("hex")
        : undefined;
    if (key && approved.has(key)) {
      return "granted";
    }
    const { createModelExecAutoReviewer } = await import("../agents/exec-auto-reviewer.js");
    const review = await resolveExecAutoReviewDecision(
      createModelExecAutoReviewer({
        cfg,
        agentId,
        reviewer:
          resolveAgentConfig(cfg, agentId)?.tools?.exec?.reviewer ?? cfg.tools?.exec?.reviewer,
      }),
      { kind: "board-widget", name, declared, agent: { id: agentId, sessionKey } },
    );
    switch (review.decision) {
      case "allow-once": {
        if (review.risk !== "low") {
          return "rejected";
        }
        // A concurrent request can replace the policy/config generation during review.
        if (key && configRevision === currentConfigRevision && policyRevision === policy.revision) {
          if (approved.size >= 256) {
            approved.delete(approved.keys().next().value!);
          }
          approved.add(key);
        }
        return "granted";
      }
      case "deny":
      case "ask":
        return "rejected";
      default:
        throw new Error("Unsupported widget review decision", { cause: review satisfies never });
    }
  };
}
