import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  decodeIdentityPreferences,
  decodePalettePreference,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  type NewSessionPreference,
  replaceBrowserPreference,
  resolveNewSessionFolderPreference,
} from "./preferences.ts";

describe("new-session browser preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

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
  it.each<{ name: string; choice: NewSessionPreference; browser: NewSessionPreference }>([
    { name: "placement", choice: placement, browser: placement },
    {
      name: "private repository",
      choice: {
        remoteProject: {
          identity: "acme/private-repo",
          cloneUrl: "https://ghe.example.test/acme/private-repo.git",
          defaultBranch: "main",
        },
        baseRef: "main",
      },
      browser: { baseRef: "main" },
    },
    ...([true, false, "auto", "ultrafast"] as const).map((fastMode) => ({
      name: `Fast Mode ${fastMode}`,
      choice: { fastMode },
      browser: { fastMode },
    })),
    {
      name: "fresh workspace",
      choice: { folder: "/local", worktree: true, freshWorkspace: true },
      browser: { folder: "/local", worktree: true, freshWorkspace: true },
    },
  ])("round-trips $name in the correct browser and identity scopes", ({ choice, browser }) => {
    const gateway = "ws://one.example";
    replaceBrowserPreference(gateway, "Main", choice);
    expect(loadNewSessionPreference(gateway, "main")).toEqual(browser);
    expect(loadNewSessionPreference(gateway, "research")).toBeNull();
    expect(loadNewSessionPreference("ws://two.example", "main")).toBeNull();
    expect(encodeIdentityPreferences(loadBrowserPreferences(gateway))).toEqual({
      "new-session.v1:main": browser,
    });
    expect(decodeIdentityPreferences(encodeIdentityPreferences({ main: choice }))).toEqual({
      main: choice,
    });
    expect(
      decodeIdentityPreferences(encodeIdentityPreferences(loadBrowserPreferences(gateway))),
    ).toEqual({ main: browser });
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("private-repo");
    expect(
      decodeIdentityPreferences({
        unrelated: { folder: "/ignored" },
        "new-session.v1:main": { folder: "/gateway", model: "openai/test" },
      }),
    ).toEqual({ main: { folder: "/gateway", model: "openai/test" } });
    replaceBrowserPreference(gateway, "main", { fastMode: undefined });
    expect(loadNewSessionPreference(gateway, "main")).toBeNull();
    replaceBrowserPreference(gateway, "main", { folder: "/gateway" });
    expect(loadNewSessionPreference(gateway, "main")).toEqual({ folder: "/gateway" });
  });

  it("keeps a legacy cloud source after unavailable Git clears the stored worktree flag", () => {
    const gatewayUrl = "ws://one.example";
    const legacyPreference = {
      workspace: "/workspace",
      folder: "/workspace",
      where: { kind: "cloud", id: "build-fleet" },
      worktree: true,
    };
    replaceBrowserPreference(gatewayUrl, "main", { folder: "/workspace" });
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", JSON.stringify({ agents: { main: legacyPreference } }));

    const firstLoad = loadNewSessionPreference(gatewayUrl, "main");
    expect(resolveNewSessionFolderPreference(firstLoad, "/workspace").freshWorkspace).toBe(false);
    replaceBrowserPreference(gatewayUrl, "main", { ...firstLoad, worktree: false });

    const secondLoad = loadNewSessionPreference(gatewayUrl, "main");
    expect(secondLoad).toMatchObject({ ...legacyPreference, worktree: false });
    expect(resolveNewSessionFolderPreference(secondLoad, "/workspace").freshWorkspace).toBe(false);
    replaceBrowserPreference(gatewayUrl, "main", {
      ...secondLoad,
      worktree: true,
      freshWorkspace: true,
    });
    expect(
      resolveNewSessionFolderPreference(loadNewSessionPreference(gatewayUrl, "main"), "/workspace")
        .freshWorkspace,
    ).toBe(true);
  });

  it.each([
    { fastMode: "on" },
    {
      folder: 42,
      where: { kind: "node", id: [] },
      projectId: {},
      remoteProject: { identity: [], cloneUrl: 42 },
      model: [],
      worktree: "yes",
      freshWorkspace: "yes",
    },
  ])("drops malformed persisted fields %j", (invalid) => {
    const gateway = "ws://one.example";
    replaceBrowserPreference(gateway, "main", { worktree: false, freshWorkspace: false });
    expect(loadNewSessionPreference(gateway, "main")).toEqual({
      worktree: false,
      freshWorkspace: false,
    });
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", JSON.stringify({ agents: { main: invalid } }));
    expect(loadNewSessionPreference(gateway, "main")).toBeNull();
    expect(decodeIdentityPreferences({ "new-session.v1:main": invalid })).toEqual({});
  });

  it("clears the final selection while preserving other agents", () => {
    const gateway = "ws://one.example";
    replaceBrowserPreference(gateway, "main", {
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
      thinkingLevel: "high",
    });
    replaceBrowserPreference(gateway, "research", { folder: "/research" });
    expect(loadNewSessionPreference(gateway, "main")).toEqual({
      model: "openai/gpt-5.6-sol",
      agentRuntime: "codex",
      thinkingLevel: "high",
    });
    replaceBrowserPreference(gateway, "main", {
      ...loadNewSessionPreference(gateway, "main"),
      agentRuntime: "",
    });
    expect(loadNewSessionPreference(gateway, "main")).toEqual({
      model: "openai/gpt-5.6-sol",
      thinkingLevel: "high",
    });
    replaceBrowserPreference(gateway, "main", {});
    expect(loadNewSessionPreference(gateway, "main")).toBeNull();
    expect(loadBrowserPreferences(gateway)).toEqual({ research: { folder: "/research" } });
  });
});

describe("palette placement overrides", () => {
  it("preserves cleared placement fields without taking over model defaults or one-use names", () => {
    expect(
      decodePalettePreference({
        agentId: "Main",
        selection: {
          workspace: "/workspace",
          folder: "/workspace",
          projectId: "",
          remoteProject: null,
          baseRef: "",
          worktreeName: "foreground-task",
          where: { kind: "local" },
          worktree: false,
          freshWorkspace: false,
          model: "do-not-restore",
          thinkingLevel: "high",
          fastMode: true,
        },
      }),
    ).toEqual({
      agentId: "main",
      selection: {
        workspace: "/workspace",
        folder: "/workspace",
        projectId: "",
        remoteProject: null,
        baseRef: "",
        where: { kind: "local" },
        worktree: false,
        freshWorkspace: false,
      },
    });
    expect(decodePalettePreference(null)).toBeNull();
    expect(decodePalettePreference({ agentId: "", selection: { worktree: true } })).toBeNull();
    expect(decodePalettePreference({ agentId: "main", selection: "invalid" })).toBeNull();
  });
});
