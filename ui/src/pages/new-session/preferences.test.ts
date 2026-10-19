import { beforeEach, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  decodeIdentityPreferences as decode,
  decodePalettePreference,
  encodeIdentityPreferences as encode,
  loadBrowserPreferences,
  loadNewSessionPreference,
  type NewSessionPreference,
  replaceBrowserPreference,
  resolveNewSessionFolderPreference,
} from "./preferences.ts";

const gateway = "ws://one.example";
const load = (agent = "main") => loadNewSessionPreference(gateway, agent);
const replace = (preference: NewSessionPreference, agent = "main") =>
  replaceBrowserPreference(gateway, agent, preference);
function persistRaw(preference: unknown) {
  const key = localStorage.key(0);
  expect(key).not.toBeNull();
  localStorage.setItem(key ?? "", JSON.stringify({ agents: { main: preference } }));
}

beforeEach(() => vi.stubGlobal("localStorage", createStorageMock()));

const placement: NewSessionPreference = {
  workspace: "/workspace",
  folder: "/workspace/project",
  where: { kind: "cloud", id: "build-fleet" },
  projectId: "openclaw",
  worktree: true,
  freshWorkspace: false,
  baseRef: "main",
  worktreeName: "picker-redesign",
  model: "openai/gpt-5.6-sol",
  thinkingLevel: "high",
};
const preference = (choice: NewSessionPreference, browser = choice) => ({ choice, browser });
it.each([
  preference(placement),
  preference(
    {
      remoteProject: {
        identity: "acme/private-repo",
        cloneUrl: "https://ghe.example.test/acme/private-repo.git",
        defaultBranch: "main",
      },
      baseRef: "main",
    },
    { baseRef: "main" },
  ),
  ...([true, false, "auto", "ultrafast"] as const).map((fastMode) => preference({ fastMode })),
  preference({ folder: "/local", worktree: true, freshWorkspace: true }),
])("round-trips %j in browser and identity scopes", ({ choice, browser }) => {
  replaceBrowserPreference(gateway, "Main", choice);
  expect(load()).toEqual(browser);
  expect(load("research")).toBeNull();
  expect(loadNewSessionPreference("ws://two.example", "main")).toBeNull();
  const stored = loadBrowserPreferences(gateway);
  expect(encode(stored)).toEqual({ "new-session.v1:main": browser });
  expect(decode(encode({ main: choice }))).toEqual({ main: choice });
  expect(decode(encode(stored))).toEqual({ main: browser });
  expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("private-repo");
  expect(
    decode({
      unrelated: { folder: "/ignored" },
      "new-session.v1:main": { folder: "/gateway", model: "openai/test" },
    }),
  ).toEqual({ main: { folder: "/gateway", model: "openai/test" } });
  replace({ fastMode: undefined });
  expect(load()).toBeNull();
  replace({ folder: "/gateway" });
  expect(load()).toEqual({ folder: "/gateway" });
});

it("keeps a legacy cloud source after unavailable Git clears the stored worktree flag", () => {
  const legacyPreference = {
    workspace: "/workspace",
    folder: "/workspace",
    where: { kind: "cloud", id: "build-fleet" },
    worktree: true,
  };
  replace({ folder: "/workspace" });
  persistRaw(legacyPreference);

  const firstLoad = load();
  expect(resolveNewSessionFolderPreference(firstLoad, "/workspace").freshWorkspace).toBe(false);
  replace({ ...firstLoad, worktree: false });

  const secondLoad = load();
  expect(secondLoad).toMatchObject({ ...legacyPreference, worktree: false });
  expect(resolveNewSessionFolderPreference(secondLoad, "/workspace").freshWorkspace).toBe(false);
  replace({ ...secondLoad, worktree: true, freshWorkspace: true });
  expect(resolveNewSessionFolderPreference(load(), "/workspace").freshWorkspace).toBe(true);
});

it("drops malformed persisted fields", () => {
  const invalid = {
    fastMode: "on",
    folder: 42,
    where: { kind: "node", id: [] },
    projectId: {},
    remoteProject: { identity: [], cloneUrl: 42 },
    model: [],
    worktree: "yes",
    freshWorkspace: "yes",
  };
  replace({ worktree: false, freshWorkspace: false });
  expect(load()).toEqual({ worktree: false, freshWorkspace: false });
  persistRaw(invalid);
  expect(load()).toBeNull();
  expect(decode({ "new-session.v1:main": invalid })).toEqual({});
});

it("clears the final selection while preserving other agents", () => {
  const model = { model: "openai/gpt-5.6-sol", thinkingLevel: "high" };
  replace({ ...model, agentRuntime: "codex" });
  replaceBrowserPreference(gateway, "research", { folder: "/research" });
  expect(load()).toEqual({ ...model, agentRuntime: "codex" });
  replace({ ...load(), agentRuntime: "" });
  expect(load()).toEqual(model);
  replace({});
  expect(load()).toBeNull();
  expect(loadBrowserPreferences(gateway)).toEqual({ research: { folder: "/research" } });
});
it("preserves cleared placement fields without taking over model defaults or one-use names", () => {
  const selection = {
    workspace: "/workspace",
    folder: "/workspace",
    projectId: "",
    remoteProject: null,
    baseRef: "",
    where: { kind: "local" },
    worktree: false,
    freshWorkspace: false,
  };
  expect(
    decodePalettePreference({
      agentId: "Main",
      selection: {
        ...selection,
        worktreeName: "foreground-task",
        model: "do-not-restore",
        thinkingLevel: "high",
        fastMode: true,
      },
    }),
  ).toEqual({ agentId: "main", selection });
  expect(decodePalettePreference(null)).toBeNull();
  expect(decodePalettePreference({ agentId: "", selection: { worktree: true } })).toBeNull();
  expect(decodePalettePreference({ agentId: "main", selection: "invalid" })).toBeNull();
});
