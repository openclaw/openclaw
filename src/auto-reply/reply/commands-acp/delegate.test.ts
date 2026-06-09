// Hub-delegated /acp delegate command label lookup tests.
import { describe, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../../../acp/runtime/session-meta.js";
import type { HandleCommandsParams } from "../commands-types.js";
import { handleAcpDelegateAction } from "./delegate.js";

const listOwnedHubDelegatedSessionEntriesMock = vi.hoisted(() => vi.fn());

vi.mock("../../../acp/hub-delegated-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../acp/hub-delegated-lifecycle.js")>();
  return {
    ...actual,
    listOwnedHubDelegatedSessionEntries: listOwnedHubDelegatedSessionEntriesMock,
  };
});

function createDelegateEntry(params: { sessionKey: string; label: string }): AcpSessionStoreEntry {
  return {
    cfg: {},
    storePath: "/tmp/sessions.json",
    sessionKey: params.sessionKey,
    storeSessionKey: params.sessionKey,
    entry: {
      sessionId: "sess-1",
      updatedAt: 1,
      label: params.label,
      hubDelegated: {
        ownerSessionKey: "agent:main:main",
        createdAt: 1,
      },
    },
    acp: {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "codex-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    },
  };
}

function createParams(): HandleCommandsParams {
  return {
    cfg: { acp: { delegate: {} } },
    sessionKey: "agent:main:main",
    ctx: {},
    command: {},
  } as HandleCommandsParams;
}

describe("handleAcpDelegateAction label lookup", () => {
  it("matches status/close labels with exact case-sensitive equality", async () => {
    listOwnedHubDelegatedSessionEntriesMock.mockResolvedValue([
      createDelegateEntry({ sessionKey: "agent:codex:acp:build-upper", label: "Build" }),
      createDelegateEntry({ sessionKey: "agent:codex:acp:build-lower", label: "build" }),
    ]);

    const status = await handleAcpDelegateAction(createParams(), ["status", "Build"]);
    expect(status.shouldContinue).toBe(false);
    expect(status.reply?.text).toContain("agent:codex:acp:build-upper");
    expect(status.reply?.text).not.toContain("agent:codex:acp:build-lower");
  });

  it("reports ambiguity for case-only duplicate labels", async () => {
    listOwnedHubDelegatedSessionEntriesMock.mockResolvedValue([
      createDelegateEntry({ sessionKey: "agent:codex:acp:build-upper", label: "Build" }),
      createDelegateEntry({ sessionKey: "agent:codex:acp:build-lower", label: "build" }),
    ]);

    const status = await handleAcpDelegateAction(createParams(), ["status", "BUILD"]);
    expect(status.reply?.text).toContain("Multiple hub-delegated sessions match label");
    expect(status.reply?.text).toContain("Build");
    expect(status.reply?.text).toContain("build");
  });

  it("returns missing when only a different-case label exists", async () => {
    listOwnedHubDelegatedSessionEntriesMock.mockResolvedValue([
      createDelegateEntry({ sessionKey: "agent:codex:acp:build-upper", label: "Build" }),
    ]);

    const status = await handleAcpDelegateAction(createParams(), ["status", "build"]);
    expect(status.reply?.text).toContain('No hub-delegated session with label "build"');
  });
});
