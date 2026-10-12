import { describe, expect, it } from "vitest";
import { withAuthProfileTestState } from "../../agents/auth-profiles/profile-mutations.test-support.js";
import {
  decideProviderLoginSessionAdoption,
  resolveSessionAuthProfileOverrideSource,
} from "./auth-profile-override-provenance.js";
import { contextBudgetStatusFixture } from "./context-budget.test-support.js";
import { resolveDefaultSessionStorePath } from "./paths.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

describe("resolveSessionAuthProfileOverrideSource", () => {
  it("returns undefined without a non-blank profile", () => {
    expect(resolveSessionAuthProfileOverrideSource(undefined)).toBeUndefined();
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: " ",
        authProfileOverrideSource: "user",
      }),
    ).toBeUndefined();
  });

  it("prefers explicit provenance over legacy markers", () => {
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 0,
      }),
    ).toBe("user");
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "auto",
      }),
    ).toBe("auto");
  });

  it("treats a zero compaction marker as automatic", () => {
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:fallback",
        authProfileOverrideCompactionCount: 0,
      }),
    ).toBe("auto");
  });

  it("treats a source-less profile without a compaction marker as user-selected", () => {
    expect(
      resolveSessionAuthProfileOverrideSource({
        authProfileOverride: "openai:legacy-user",
      }),
    ).toBe("user");
  });
});

describe("persisted provider login adoption", () => {
  it("retires account-bound capacity only when an unlocked session changes accounts", async () => {
    await withAuthProfileTestState("openclaw-login-context-owner-", async () => {
      const storePath = resolveDefaultSessionStorePath("main");
      for (const { name, previous, locked, preserve } of [
        { name: "changed-account", previous: "openai:previous", locked: false, preserve: false },
        {
          name: "same-account-source-promotion",
          previous: "openai:next",
          locked: false,
          preserve: true,
        },
        {
          name: "locked-native-account",
          previous: "openai:previous",
          locked: true,
          preserve: true,
        },
      ]) {
        const scope = { storePath, sessionKey: `agent:main:login-context:${name}` };
        const entry: SessionEntry = {
          sessionId: name,
          updatedAt: 1,
          modelProvider: "openai",
          model: "fixture-model",
          authProfileOverride: previous,
          authProfileOverrideSource: "auto",
          authProfileOverrideCompactionCount: 3,
          modelSelectionLocked: locked,
          agentHarnessId: locked ? "codex" : "openclaw",
          contextTokens: 888_000,
          contextTokensSource: "resolved-v1",
          contextBudgetStatus: contextBudgetStatusFixture({
            sessionId: name,
            contextTokenBudget: 888_000,
          }),
        };
        await replaceSessionEntry(scope, entry);
        const snapshot = loadSessionEntry({ ...scope, readConsistency: "latest" });
        expect(snapshot?.sessionId).toBe(name);
        await patchSessionEntryCore(
          scope,
          (current) => {
            const decision = decideProviderLoginSessionAdoption({
              currentModelProvider: "openai",
              loginProvider: "openai",
              nextProfileId: "openai:next",
              snapshot,
              current,
            });
            expect(decision.status).toBe("patch");
            return decision.status === "patch" ? decision.patch : null;
          },
          { requireWriteSuccess: true, skipMaintenance: true },
        );
        const persisted = loadSessionEntry({ ...scope, readConsistency: "latest" });
        expect(persisted?.sessionId).toBe(name);
        expect(persisted?.authProfileOverride).toBe("openai:next");
        expect(persisted?.authProfileOverrideSource).toBe("user");
        expect(persisted?.authProfileOverrideCompactionCount).toBeUndefined();
        expect.soft(persisted?.contextTokens).toBe(preserve ? 888_000 : undefined);
        expect.soft(persisted?.contextTokensSource).toBe(preserve ? "resolved-v1" : undefined);
        expect
          .soft(persisted?.contextBudgetStatus)
          .toEqual(preserve ? entry.contextBudgetStatus : undefined);
      }
    });
  });
});
