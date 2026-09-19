import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  decodeIdentityPreferences,
  decodePalettePreference,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  replaceBrowserPreference,
  resolveNewSessionFolderPreference,
} from "./preferences.ts";

describe("new-session browser preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  it("keeps selections isolated by Gateway and agent", () => {
    replaceBrowserPreference("ws://one.example", "Main", {
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
    });

    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
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
    });
    expect(loadNewSessionPreference("ws://one.example", "research")).toBeNull();
    expect(loadNewSessionPreference("ws://two.example", "main")).toBeNull();
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

  it("preserves boolean choices and drops malformed persisted fields", () => {
    replaceBrowserPreference("ws://one.example", "main", {
      worktree: false,
      freshWorkspace: false,
    });

    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      worktree: false,
      freshWorkspace: false,
    });

    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(
      key ?? "",
      JSON.stringify({
        agents: {
          main: {
            folder: 42,
            where: { kind: "node", id: [] },
            projectId: {},
            model: [],
            worktree: "yes",
            freshWorkspace: "yes",
          },
        },
      }),
    );
    expect(loadNewSessionPreference("ws://one.example", "main")).toBeNull();
  });

  it("round-trips normalized browser preferences through identity keys", () => {
    replaceBrowserPreference("ws://one.example", "Main", {
      folder: "/local",
      worktree: true,
      freshWorkspace: true,
    });
    const browser = loadBrowserPreferences("ws://one.example");
    expect(encodeIdentityPreferences(browser)).toEqual({
      "new-session.v1:main": { folder: "/local", worktree: true, freshWorkspace: true },
    });
    expect(
      decodeIdentityPreferences({
        unrelated: { folder: "/ignored" },
        "new-session.v1:main": { folder: "/gateway", model: "openai/test" },
      }),
    ).toEqual({ main: { folder: "/gateway", model: "openai/test" } });

    replaceBrowserPreference("ws://one.example", "main", { folder: "/gateway" });
    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      folder: "/gateway",
    });
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
          baseRef: "",
          worktreeName: "foreground-task",
          where: { kind: "local" },
          worktree: false,
          freshWorkspace: false,
          model: "do-not-restore",
          thinkingLevel: "high",
        },
      }),
    ).toEqual({
      agentId: "main",
      selection: {
        workspace: "/workspace",
        folder: "/workspace",
        projectId: "",
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
