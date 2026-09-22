import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  decodeIdentityPreferences,
  encodeIdentityPreferences,
  loadBrowserPreferences,
  loadNewSessionPreference,
  patchNewSessionPreference,
  replaceBrowserPreference,
  resolveNewSessionFolderPreference,
} from "./preferences.ts";

describe("new-session browser preferences", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", createStorageMock());
  });

  it("keeps selections isolated by Gateway and agent", () => {
    patchNewSessionPreference("ws://one.example", "Main", {
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
    patchNewSessionPreference(gatewayUrl, "main", { folder: "/workspace" });
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key ?? "", JSON.stringify({ agents: { main: legacyPreference } }));

    const firstLoad = loadNewSessionPreference(gatewayUrl, "main");
    expect(resolveNewSessionFolderPreference(firstLoad, "/workspace").freshWorkspace).toBe(false);
    patchNewSessionPreference(gatewayUrl, "main", { worktree: false });

    const secondLoad = loadNewSessionPreference(gatewayUrl, "main");
    expect(secondLoad).toMatchObject({ ...legacyPreference, worktree: false });
    expect(resolveNewSessionFolderPreference(secondLoad, "/workspace").freshWorkspace).toBe(false);
    patchNewSessionPreference(gatewayUrl, "main", { worktree: true, freshWorkspace: true });
    expect(
      resolveNewSessionFolderPreference(loadNewSessionPreference(gatewayUrl, "main"), "/workspace")
        .freshWorkspace,
    ).toBe(true);
  });

  it("merges changes and drops malformed persisted fields", () => {
    patchNewSessionPreference("ws://one.example", "main", { folder: "/first" });
    patchNewSessionPreference("ws://one.example", "main", {
      worktree: false,
      freshWorkspace: false,
    });

    expect(loadNewSessionPreference("ws://one.example", "main")).toEqual({
      folder: "/first",
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
    patchNewSessionPreference("ws://one.example", "Main", {
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

  it.each(["patch", "replace"] as const)(
    "clears the final selection with %s while preserving other agents",
    (mode) => {
      const gateway = "ws://one.example";
      patchNewSessionPreference(gateway, "main", {
        model: "openai/gpt-5.6-sol",
        agentRuntime: "codex",
        thinkingLevel: "high",
      });
      patchNewSessionPreference(gateway, "research", { folder: "/research" });
      patchNewSessionPreference(gateway, "main", {});
      expect(loadNewSessionPreference(gateway, "main")).toEqual({
        model: "openai/gpt-5.6-sol",
        agentRuntime: "codex",
        thinkingLevel: "high",
      });
      patchNewSessionPreference(gateway, "main", { agentRuntime: "" });
      expect(loadNewSessionPreference(gateway, "main")).toEqual({
        model: "openai/gpt-5.6-sol",
        thinkingLevel: "high",
      });
      if (mode === "patch") {
        patchNewSessionPreference(gateway, "main", { model: "", thinkingLevel: "" });
      } else {
        replaceBrowserPreference(gateway, "main", {});
      }
      expect(loadNewSessionPreference(gateway, "main")).toBeNull();
      expect(loadBrowserPreferences(gateway)).toEqual({ research: { folder: "/research" } });
    },
  );
});
