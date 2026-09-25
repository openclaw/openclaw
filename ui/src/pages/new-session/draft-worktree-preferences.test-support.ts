import { isDeepStrictEqual } from "node:util";
import { expect, vi } from "vitest";
import type { UsersPrefsSetParams } from "../../../../packages/gateway-protocol/src/schema/users.ts";
import { saveUserPreferences } from "../../app/user-prefs-cache.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { loadNewSessionPreference, replaceBrowserPreference } from "./preferences.ts";

export function identityPreferences(
  identified = true,
  modelCatalog?: NonNullable<Parameters<typeof createDraftFixture>[0]>["modelCatalog"],
  initialEntries?: Record<string, unknown>,
) {
  let entries: Record<string, unknown> = initialEntries ?? {
    "new-session.migration.v1": true,
    "new-session.v1:work": {
      workspace: "/work",
      folder: "/work",
      worktree: true,
      baseRef: "main",
      worktreeName: "work-task",
    },
    "new-session.v1:main": {
      workspace: "/repo",
      folder: "/repo",
      worktree: true,
      baseRef: "main",
      worktreeName: "first-task",
    },
  };
  if (!identified) {
    replaceBrowserPreference("ws://gateway.example", "main", {
      workspace: "/repo",
      folder: "/repo",
      worktree: true,
      baseRef: "main",
      worktreeName: "first-task",
    });
  }
  const beforeSave = vi.fn(async (_params: UsersPrefsSetParams) => {});
  const beforeRead = vi.fn(async () => {});
  const options = {
    modelCatalog,
    ...(identified ? { selfUser: { id: "person-a" } } : {}),
    scopes: ["operator.admin", "operator.read", "operator.write"],
    methods: ["sessions.create", "sessions.dispatch", "users.prefs.get", "users.prefs.set"],
    agents: [
      {
        id: "work",
        workspace: "/work",
        workspaceGit: true,
        model: { primary: "openai/gpt-5.6-luna" },
      },
      {
        id: "main",
        workspace: "/repo",
        workspaceGit: true,
        model: { primary: "openai/gpt-5.6-luna" },
      },
    ],
    request: async (method: string, params?: unknown) => {
      if (method === "users.prefs.get") {
        const snapshot = structuredClone(entries);
        await beforeRead();
        return { status: "ok", entries: snapshot };
      }
      if (method === "users.prefs.set") {
        const write = params as UsersPrefsSetParams;
        await beforeSave(write);
        if (
          Object.entries(write.expectedEntries ?? {}).some(([key, expected]) =>
            expected === null
              ? Object.hasOwn(entries, key)
              : !isDeepStrictEqual(entries[key], expected),
          )
        ) {
          return { status: "conflict" };
        }
        entries = { ...entries, ...structuredClone(write.entries) };
        return { status: "ok" };
      }
      if (method === "worktrees.branches") {
        return { repositoryStatus: "git", branches: ["main"], defaultBranch: "main" };
      }
      return { status: "ok", endedAt: 1 };
    },
  };
  const make = (gateway?: NonNullable<Parameters<typeof createDraftFixture>[0]>["gateway"]) =>
    createDraftFixture({ ...options, gateway });
  const ready = async (fixture: ReturnType<typeof make>) => {
    await vi.waitFor(() => expect(fixture.gateway.preferenceLoading).toBe(false));
    await vi.waitFor(() => expect(fixture.place.repository.kind).toBe("git"));
  };
  return {
    make,
    ready,
    beforeSave,
    beforeRead,
    publish: (fixture: ReturnType<typeof make>, patch: Record<string, unknown>) =>
      saveUserPreferences(fixture.context.gateway.snapshot.client!, {
        entries: {
          "new-session.v1:main": { ...(entries["new-session.v1:main"] as object), ...patch },
        },
      }),
    stored: (agentId = "main") =>
      identified
        ? entries[`new-session.v1:${agentId}`]
        : loadNewSessionPreference("ws://gateway.example", agentId),
  };
}
