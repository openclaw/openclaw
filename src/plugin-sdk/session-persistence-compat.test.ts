import type {
  ExtensionAPI,
  SessionEntry as TranscriptSessionEntry,
  SessionManager,
} from "openclaw/plugin-sdk/agent-sessions";
import type { ProviderReplaySessionState as CoreReplayState } from "openclaw/plugin-sdk/core";
import type { ProviderReplaySessionState as PluginReplayState } from "openclaw/plugin-sdk/plugin-entry";
import type {
  getSessionEntry,
  patchSessionEntry,
  SessionEntry,
  updateSessionStoreEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { TranscriptEntryAnchor } from "openclaw/plugin-sdk/session-transcript-runtime";
import { expectTypeOf, it } from "vitest";

// Released contracts: v2026.9.9 (bcfc88812a35243893585dbeca87ca41b48272ca).
// Transcript callback types and execution ordering have their own preparation-compat
// and runtime.worker-preparation fixtures; these imports must remain type-only.
it("retains released synchronous SessionManager persistence results", () => {
  type IdWriter =
    | "appendMessage"
    | "appendCompaction"
    | "appendResetBoundary"
    | "appendCustomEntry"
    | "appendSessionInfo"
    | "appendCustomMessageEntry"
    | "appendLabelChange"
    | "branchWithSummary";
  expectTypeOf<ReturnType<SessionManager[IdWriter]>>().toEqualTypeOf<string>();
  expectTypeOf<
    ReturnType<typeof SessionManager.appendMessageToTranscript>
  >().toEqualTypeOf<string>();
  expectTypeOf<ReturnType<SessionManager["removeTrailingEntries"]>>().toEqualTypeOf<number>();
  expectTypeOf<SessionManager["appendCustomEntry"]>().toEqualTypeOf<
    (customType: string, data?: unknown) => string
  >();
  expectTypeOf<ReturnType<SessionManager["appendMessageWithTranscriptAnchor"]>>().toEqualTypeOf<{
    entryId: string;
    message: Extract<TranscriptSessionEntry, { type: "message" }>["message"];
    anchor?: TranscriptEntryAnchor;
    lifecycleRevision?: string;
    appended: boolean;
  }>();
  type LeafControl = ReturnType<SessionManager["appendLeafControl"]>;
  expectTypeOf<{ [Key in keyof LeafControl]: LeafControl[Key] }>().toEqualTypeOf<{
    type: "leaf";
    id: string;
    parentId: string | null;
    timestamp: string;
    targetId: string | null;
    appendParentId?: string | null;
    appendMode?: "side";
  }>();
  expectTypeOf<ReturnType<SessionManager["persist"]>>().toEqualTypeOf<
    | undefined
    | {
        anchor?: TranscriptEntryAnchor;
        lifecycleRevision?: string;
        appended: boolean;
        adoptedMessageId?: string;
        effectiveParentId: string | null;
        reloadAfterAppend?: boolean;
      }
  >();
  type Rewrite = ReturnType<SessionManager["prepareTranscriptRewrite"]>;
  expectTypeOf<Rewrite["commit"]>().toEqualTypeOf<
    (rewrittenEntryIds: ReadonlyMap<string, string>) => void
  >();
  expectTypeOf<ReturnType<Rewrite["commit"]>>().toEqualTypeOf<void>();
});

it("retains released extension and replay methods with exact void returns", () => {
  expectTypeOf<Parameters<ExtensionAPI["appendEntry"]>>().toEqualTypeOf<
    [customType: string, data?: unknown]
  >();
  expectTypeOf<Parameters<ExtensionAPI["setSessionName"]>>().toEqualTypeOf<[name: string]>();
  expectTypeOf<Parameters<ExtensionAPI["setLabel"]>>().toEqualTypeOf<
    [entryId: string, label: string | undefined]
  >();
  expectTypeOf<ReturnType<ExtensionAPI["appendEntry"]>>().toEqualTypeOf<void>();
  expectTypeOf<ReturnType<ExtensionAPI["setSessionName"]>>().toEqualTypeOf<void>();
  expectTypeOf<ReturnType<ExtensionAPI["setLabel"]>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<CoreReplayState["appendCustomEntry"]>>().toEqualTypeOf<
    [customType: string, data: unknown]
  >();
  expectTypeOf<ReturnType<CoreReplayState["appendCustomEntry"]>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<PluginReplayState["appendCustomEntry"]>>().toEqualTypeOf<
    [customType: string, data: unknown]
  >();
  expectTypeOf<ReturnType<PluginReplayState["appendCustomEntry"]>>().toEqualTypeOf<void>();
});

it("retains released session-store callbacks alongside prepared replacements", () => {
  type Patch = Parameters<typeof patchSessionEntry>[0];
  expectTypeOf<Patch["update"]>().toEqualTypeOf<
    (
      entry: SessionEntry,
      context: { existingEntry?: SessionEntry },
    ) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null
  >();
  expectTypeOf<Patch["assertCommitAllowed"]>().toEqualTypeOf<(() => void) | undefined>();
  expectTypeOf<ReturnType<NonNullable<Patch["assertCommitAllowed"]>>>().toEqualTypeOf<void>();
  expectTypeOf<Parameters<typeof updateSessionStoreEntry>[0]["update"]>().toEqualTypeOf<
    (entry: SessionEntry) => Promise<Partial<SessionEntry> | null> | Partial<SessionEntry> | null
  >();
  expectTypeOf<ReturnType<typeof getSessionEntry>>().toEqualTypeOf<SessionEntry | undefined>();
  expectTypeOf<ReturnType<typeof patchSessionEntry>>().toEqualTypeOf<
    Promise<SessionEntry | null>
  >();
  expectTypeOf<ReturnType<typeof updateSessionStoreEntry>>().toEqualTypeOf<
    Promise<SessionEntry | null>
  >();
});
