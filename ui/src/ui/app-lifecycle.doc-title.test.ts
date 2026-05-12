// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleUpdated, syncDocumentTitleFromHost } from "./app-lifecycle.ts";

function createHost(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    basePath: "",
    client: null,
    connectGeneration: 0,
    connected: true,
    tab: "chat",
    assistantName: "",
    assistantAvatar: null,
    assistantAgentId: null,
    localMediaPreviewRoots: [],
    embedSandboxMode: "strict",
    allowExternalEmbedUrls: false,
    chatHasAutoScrolled: true,
    chatManualRefreshInFlight: false,
    chatLoading: false,
    chatMessages: [],
    chatToolMessages: [],
    chatStream: null,
    logsAutoFollow: false,
    logsAtBottom: true,
    logsEntries: [],
    sessionsChangedReloadTimer: null as number | ReturnType<typeof globalThis.setTimeout> | null,
    popStateHandler: vi.fn(),
    topbarObserver: null,
    ...overrides,
  };
}

describe("Control UI document.title sync (#80942)", () => {
  const originalTitle = document.title;
  beforeEach(() => {
    document.title = "OpenClaw";
  });
  afterEach(() => {
    document.title = originalTitle;
  });

  it("falls back to Control · OpenClaw when no agent identity is set", () => {
    const host = createHost();
    syncDocumentTitleFromHost(host as unknown as Parameters<typeof syncDocumentTitleFromHost>[0]);
    expect(document.title).toBe("Control \u00b7 OpenClaw");
  });

  it("uses assistantName when present", () => {
    const host = createHost({ assistantName: "Milly" });
    syncDocumentTitleFromHost(host as unknown as Parameters<typeof syncDocumentTitleFromHost>[0]);
    expect(document.title).toBe("Milly \u00b7 OpenClaw");
  });

  it("falls back to assistantAgentId when assistantName is blank", () => {
    const host = createHost({ assistantName: "", assistantAgentId: "milly" });
    syncDocumentTitleFromHost(host as unknown as Parameters<typeof syncDocumentTitleFromHost>[0]);
    expect(document.title).toBe("milly \u00b7 OpenClaw");
  });

  it("handleUpdated updates document.title when assistantName changes", () => {
    const host = createHost({ assistantName: "Sherry", tab: "logs" });
    const changed = new Map<PropertyKey, unknown>([["assistantName", ""]]);
    handleUpdated(host as unknown as Parameters<typeof handleUpdated>[0], changed);
    expect(document.title).toBe("Sherry \u00b7 OpenClaw");
  });

  it("handleUpdated updates document.title when assistantAgentId changes", () => {
    const host = createHost({ assistantAgentId: "judy", tab: "logs" });
    const changed = new Map<PropertyKey, unknown>([["assistantAgentId", null]]);
    handleUpdated(host as unknown as Parameters<typeof handleUpdated>[0], changed);
    expect(document.title).toBe("judy \u00b7 OpenClaw");
  });

  it("handleUpdated leaves title alone when neither identity field changed", () => {
    const host = createHost({ assistantName: "Milly", tab: "logs" });
    document.title = "stale";
    const changed = new Map<PropertyKey, unknown>([["logsEntries", []]]);
    handleUpdated(host as unknown as Parameters<typeof handleUpdated>[0], changed);
    expect(document.title).toBe("stale");
  });
});
