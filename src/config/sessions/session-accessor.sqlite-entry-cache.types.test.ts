import { expect, it, vi } from "vitest";
import { resolveSessionWorkStartError } from "./lifecycle.js";
import {
  projectSessionSharingEntry,
  sessionSharingEntriesEqual,
} from "./session-accessor.sqlite-entry-cache.types.js";
import type { InternalSessionEntry } from "./types.js";

const sessionId = "sharing-lifecycle";
const providerReview = {
  id: "review-1",
  sessionId,
  runId: "refused-run",
  provider: "openai",
  model: "test-model",
  runtimeId: "codex",
};
const tombstone = {
  cycleId: "recovery-cycle",
  revision: 1,
  chargedAttempts: 1,
  tombstone: { reason: "recovery exhausted" },
} satisfies NonNullable<InternalSessionEntry["mainRestartRecovery"]>;

const workspacePending = "workspace is not ready";
const cases: [string, Partial<InternalSessionEntry>, string?][] = [
  ["allowed session", {}],
  ["provider pause", { providerReview }, "paused as a precaution"],
  ["pending initialization", { initializationPending: true }, "still initializing"],
  ["incognito age despite recent activity", { incognito: true, createdAt: 1 }, "expired"],
  ["restart tombstone", { mainRestartRecovery: tombstone }, "Use Resume in WebChat"],
  [
    "restart tombstone with model lock",
    { mainRestartRecovery: tombstone, modelSelectionLocked: true },
    "cannot be replaced while model selection is locked",
  ],
  ["pending project", { pendingProjectGitUrl: "https://example.org/repo.git" }, workspacePending],
  ["pending worktree", { pendingWorktree: { titleSource: "New checkout" } }, workspacePending],
];

it.each(cases)(
  "preserves %s work-start behavior in retained sharing facts",
  (_name, changes, message) => {
    const entry: InternalSessionEntry = { sessionId, updatedAt: Date.now(), ...changes };
    const key = entry.incognito ? "agent:main:dashboard:incognito-lifecycle" : "agent:main:main";
    const expected = resolveSessionWorkStartError(key, entry);
    if (message) {
      expect(expected).toContain(message);
    } else {
      expect(expected).toBeUndefined();
    }
    expect(resolveSessionWorkStartError(key, projectSessionSharingEntry(entry))).toBe(expected);
  },
);

it("retains independent nested lifecycle records after the source entry changes", () => {
  const review = {
    ...providerReview,
    review: {
      explanation: "Inspect the selected operation.",
      continuation: { message: "Continue only within the selected project." },
      errorType: "misalignment_policy_violation",
    },
  } satisfies NonNullable<InternalSessionEntry["providerReview"]>;
  const mainRestartRecovery = structuredClone(tombstone);
  const pendingWorktree = {
    titleSource: "New checkout",
    source: { kind: "project", id: "original-project" },
  } satisfies NonNullable<InternalSessionEntry["pendingWorktree"]>;
  const entry: InternalSessionEntry = {
    sessionId,
    updatedAt: 1,
    providerReview: review,
    mainRestartRecovery,
    pendingWorktree,
  };
  const expected = structuredClone(entry);
  const retained = projectSessionSharingEntry(entry);

  review.review.continuation.message = "Changed continuation";
  mainRestartRecovery.tombstone.reason = "Changed recovery";
  pendingWorktree.source.id = "replacement-project";

  for (const key of ["providerReview", "mainRestartRecovery", "pendingWorktree"] as const) {
    expect(retained[key]).toEqual(expected[key]);
  }
});

it("captures inherited tool policy once and keeps both sides independently mutable", () => {
  const entry: InternalSessionEntry = {
    sessionId,
    updatedAt: 1,
    inheritedToolAllow: ["read", "write"],
    inheritedToolDeny: ["exec"],
  };
  // Array spreads iterate; the snapshot's structured clone already copies these arrays.
  using allowCopies = vi.spyOn(entry.inheritedToolAllow!, Symbol.iterator);
  using denyCopies = vi.spyOn(entry.inheritedToolDeny!, Symbol.iterator);
  const retained = projectSessionSharingEntry(entry);
  expect(sessionSharingEntriesEqual(entry, retained)).toBe(true);
  expect(allowCopies).not.toHaveBeenCalled();
  expect(denyCopies).not.toHaveBeenCalled();

  entry.inheritedToolAllow!.push("edit");
  entry.inheritedToolDeny![0] = "browser";
  expect(retained.inheritedToolAllow).toEqual(["read", "write"]);
  expect(retained.inheritedToolDeny).toEqual(["exec"]);
  expect(sessionSharingEntriesEqual(entry, retained)).toBe(false);

  retained.inheritedToolAllow![0] = "search";
  retained.inheritedToolDeny!.push("process");
  expect(entry.inheritedToolAllow).toEqual(["read", "write", "edit"]);
  expect(entry.inheritedToolDeny).toEqual(["browser"]);
});
