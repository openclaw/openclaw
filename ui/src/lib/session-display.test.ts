// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  isSessionTitlePending,
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkContext,
  resolveSessionWorkSubtitle,
} from "./session-display.ts";

describe("isSessionTitlePending", () => {
  const key = "agent:main:dashboard:naming";

  it("uses naming settlement, not the lifetime of the first reply", () => {
    expect(isSessionTitlePending(key, { titlePending: true })).toBe(true);
    expect(isSessionTitlePending(key, { titlePending: false })).toBe(false);
    expect(isSessionTitlePending(key, {})).toBe(false);
    expect(isSessionTitlePending("agent:main:main", { titlePending: true })).toBe(false);
  });

  it.each(["label", "displayName", "derivedTitle"] as const)("prefers a usable %s", (field) => {
    expect(isSessionTitlePending(key, { titlePending: true, [field]: "Release readiness" })).toBe(
      false,
    );
    expect(isSessionTitlePending(key, { titlePending: true, [field]: "  " })).toBe(true);
    expect(isSessionTitlePending(key, { titlePending: true, [field]: key })).toBe(true);
  });
});

describe("resolveSessionDisplayName", () => {
  it.each(["Subagent [worker]:"])("treats translated prefix %s as literal text", (prefix) => {
    const translation = vi.spyOn(i18n, "t").mockReturnValue(prefix);
    try {
      const key = "agent:main:subagent:worker";
      const row = { label: `${prefix} Research sources` };
      expect(resolveSessionDisplayName(key, row)).toBe("Research sources");
    } finally {
      translation.mockRestore();
    }
  });

  it("uses the same friendly main-thread name for every agent", () => {
    for (const key of ["main", "agent:main:main", "agent:research:main", "agent:ops-team:main"]) {
      expect(resolveSessionDisplayName(key)).toBe("Main Session");
    }

    expect(resolveSessionDisplayName("agent:research:main", { displayName: "Research desk" })).toBe(
      "Research desk",
    );
    expect(resolveSessionDisplayName("agent:research:dashboard:main")).toBe("New session");
    expect(resolveSessionDisplayName("agent:research:main:thread")).toBe("main:thread");
  });

  // Rows are shaped like the Gateway projection: displayName plus the
  // accountId it derives from the canonical route, no user label.
  it.each([
    {
      name: "an unnamed shipped dm row reads as a friendly peer plus account",
      key: "agent:main:telegram:cards:dm:491234567890",
      row: { accountId: "cards" },
      expected: "Telegram · …567890 · cards",
    },
    {
      name: "a stored label that already ends in the account suffix is left alone",
      key: "agent:main:telegram:cards:direct:42",
      row: { accountId: "cards", label: "Alice · cards" },
      expected: "Alice · cards",
    },
    {
      name: "a canonical group key is unchanged",
      key: "agent:main:telegram:group:-1001234567890",
      row: undefined,
      expected: "Telegram Group",
    },
  ])("$name", ({ key, row, expected }) => {
    expect(resolveSessionDisplayName(key, row)).toBe(expected);
  });

  it("does not split UTF-16 surrogate pairs when shortening peer ids", () => {
    expect(resolveSessionDisplayName("agent:main:telegram:direct:12345😀67890")).toBe(
      "Telegram · …67890",
    );
  });

  it("keeps explicit and worktree names ahead of derived titles", () => {
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        label: "Release room",
        derivedTitle: "Quarterly launch plan",
      }),
    ).toBe("Release room");
    expect(
      resolveSessionDisplayName("agent:main:dashboard:uuid", {
        worktree: { branch: "openclaw/wt-3f2a", repoRoot: "/repo/clawdbot" },
        derivedTitle: "Quarterly launch plan",
      }),
    ).toBe("clawdbot ⎇ wt-3f2a");
  });

  it("names named subsessions after their slug, never the raw agent key", () => {
    expect(resolveSessionDisplayName("agent:main:node-proof-claude")).toBe("node-proof-claude");
    expect(resolveSessionDisplayName("agent:main:explicit:node-mcp-debug")).toBe("node-mcp-debug");
    expect(
      resolveSessionDisplayName(
        "agent:main:explicit:model-run-0f9d5c1e-6d0f-4c9a-9d84-1c2f3a4b5c6d",
      ),
    ).toBe("model-run-…5c6d");
    expect(resolveSessionDisplayName("agent:main:node-fleet-4de003fbff138fcb9239c9378b2e")).toBe(
      "node-fleet-…8b2e",
    );
  });

  it("uses plain subagent names and preserves the unnamed fallback", () => {
    const key = "agent:main:subagent:worker";
    expect(resolveSessionDisplayName(key, { label: "Research sources" })).toBe("Research sources");
    expect(resolveSessionDisplayName(key, { label: "Subagent: Research sources" })).toBe(
      "Research sources",
    );
    expect(resolveSessionDisplayName(key, { displayName: "Research sources" })).toBe(
      "Research sources",
    );
    expect(resolveSessionDisplayName(key, { derivedTitle: "Research sources" })).toBe(
      "Research sources",
    );
    expect(resolveSessionDisplayName(key)).toBe("Subagent");
    expect(resolveSessionDisplayName("agent:main:cron:daily", { label: "Daily" })).toBe(
      "Automation: Daily",
    );
    expect(
      resolveSessionDisplayName("agent:main:dashboard:task", { label: "Subagent: explicit title" }),
    ).toBe("Subagent: explicit title");
  });

  it("strips persisted pre-rename Cron labels instead of double-prefixing", () => {
    expect(
      resolveSessionDisplayName("agent:main:cron:daily", { label: "Cron: daily-report" }),
    ).toBe("Automation: daily-report");
    expect(resolveSessionDisplayName("agent:main:cron:daily", { label: "Cron Job: nightly" })).toBe(
      "Automation: nightly",
    );
  });
});

describe("resolveSessionWorkSubtitle", () => {
  it("combines repo, branch, and node host", () => {
    expect(
      resolveSessionWorkSubtitle({
        repository: {
          url: "https://github.com/openclaw/openclaw.git",
          branch: "openclaw/cloud-task",
        },
      }),
    ).toBe("openclaw ⎇ openclaw/cloud-task");
    expect(
      resolveSessionWorkSubtitle({
        worktree: { branch: "openclaw/session-ui", repoRoot: "/repo/clawdbot" },
      }),
    ).toBe("clawdbot ⎇ session-ui");
    expect(
      resolveSessionWorkSubtitle({
        worktree: { branch: "feature/x", repoRoot: "/repo/clawdbot" },
        execNode: "macbook",
      }),
    ).toBe("clawdbot ⎇ feature/x · macbook");
    expect(resolveSessionWorkSubtitle({ execNode: "macbook" })).toBe("macbook");
    expect(resolveSessionWorkSubtitle({})).toBeUndefined();
  });
});

describe("resolveSessionWorkContext", () => {
  it("projects only repository or authoritative workspace facts", () => {
    expect(
      resolveSessionWorkContext({
        worktree: { branch: "openclaw/session-ui", repoRoot: "/repo/openclaw" },
        spawnedCwd: "/worktrees/session-ui/packages/ui",
      }),
    ).toEqual({
      kind: "project",
      name: "openclaw",
      path: "/repo/openclaw",
      cwd: "/worktrees/session-ui/packages/ui",
      branch: "session-ui",
    });
    expect(
      resolveSessionWorkContext({
        spawnedWorkspaceDir: "/workspaces/release-notes",
        spawnedCwd: "/stale/cwd",
      }),
    ).toEqual({
      kind: "workspace",
      name: "release-notes",
      path: "/workspaces/release-notes",
    });
    expect(
      resolveSessionWorkContext({
        execNode: "remote-node",
        execCwd: "/remote/workspace",
        spawnedWorkspaceDir: "/local/workspace",
        worktree: { branch: "openclaw/local-branch", repoRoot: "/gateway/repo" },
      }),
    ).toEqual({ kind: "workspace", name: "workspace", path: "/remote/workspace" });
    expect(resolveSessionWorkContext({ execCwd: "/stale/local-routing-cwd" })).toBeUndefined();
    expect(
      resolveSessionWorkContext({
        repository: {
          url: "https://github.com/example/project.git",
          branch: "openclaw/feature-cloud",
        },
        execNode: "cloud-node",
        execCwd: "/remote/project",
        worktree: { branch: "stale-local-branch", repoRoot: "/gateway/repo" },
      }),
    ).toEqual({
      kind: "project",
      name: "project",
      path: "https://github.com/example/project",
      cwd: "/remote/project",
      branch: "openclaw/feature-cloud",
    });
    expect(
      resolveSessionWorkContext({
        repository: {
          url: "https://github.com/example/project.git",
          branch: "openclaw/feature-cloud",
        },
        spawnedCwd: "/gateway/unrelated",
      }),
    ).toEqual({
      kind: "project",
      name: "project",
      path: "https://github.com/example/project",
      cwd: undefined,
      branch: "openclaw/feature-cloud",
    });
    expect(
      resolveSessionWorkContext({
        repository: { url: "https://github.com/example/project.git", branch: "main" },
        placement: {
          state: "reclaimed",
          providerId: "example",
          profileId: "test",
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 2,
          stateChangedAtMs: 2,
          remoteWorkspaceDir: "/cloud/project",
        },
        execCwd: "/gateway/stale-routing",
        spawnedCwd: "/gateway/unrelated",
      }),
    ).toEqual({
      kind: "project",
      name: "project",
      path: "https://github.com/example/project",
      cwd: "/cloud/project",
      branch: "main",
    });
  });
});

describe("resolveChannelSessionInfo", () => {
  it("classifies channel-shaped keys and keeps main/dashboard out", () => {
    expect(resolveChannelSessionInfo("agent:main:telegram:group:99")).toEqual({
      channel: "telegram",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:slack:channel:C1")).toEqual({
      channel: "slack",
      channelSession: true,
    });
    // Shipped pre-#11881 keys spell direct chats `dm`; they are still channel sessions.
    expect(resolveChannelSessionInfo("agent:main:telegram:cards:dm:42")).toEqual({
      channel: "telegram",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:dm:+123", "whatsapp")).toEqual({
      channel: "whatsapp",
      channelSession: true,
    });
    // Accounts qualify direct chats only, so these key shapes name no channel
    // and must not be filed under one the canonical parser would reject.
    expect(resolveChannelSessionInfo("agent:main:telegram:work:group:room")).toEqual({
      channelSession: false,
    });
    expect(resolveChannelSessionInfo("agent:main:slack:acct-1:channel:C1")).toEqual({
      channelSession: false,
    });
    expect(resolveChannelSessionInfo("agent:main:dm:account:group:room")).toEqual({
      channelSession: false,
    });
    // dmScope per-peer keys have no channel segment; the row channel wins.
    expect(resolveChannelSessionInfo("agent:main:direct:+123", "whatsapp")).toEqual({
      channel: "whatsapp",
      channelSession: true,
    });
    expect(resolveChannelSessionInfo("agent:main:main", "telegram")).toEqual({
      channelSession: false,
    });
    expect(resolveChannelSessionInfo("agent:main:dashboard:uuid")).toEqual({
      channelSession: false,
    });
  });
});

it("displays device folder provenance instead of stale Gateway workspace metadata", () => {
  const row = {
    deviceFolder: { deviceId: "build-runner", path: "/srv/existing" },
    spawnedCwd: "/gateway/stale",
    worktree: { repoRoot: "/gateway/stale", branch: "main" },
  };
  expect(resolveSessionWorkContext(row)).toEqual({
    kind: "workspace",
    name: "existing",
    path: "/srv/existing",
  });
  expect(resolveSessionWorkSubtitle(row)).toBe("/srv/existing · build-runner");
});
