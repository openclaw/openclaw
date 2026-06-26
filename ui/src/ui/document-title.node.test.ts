// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_DOCUMENT_TITLE,
  resolveControlUiDocumentTitle,
  syncControlUiDocumentTitle,
} from "./document-title.ts";
import type { SessionsListResult } from "./types.ts";

function sessionsResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "/api/sessions",
    count: sessions.length,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions,
  };
}

function sessionRow(
  row: Partial<SessionsListResult["sessions"][number]> & { key: string },
): SessionsListResult["sessions"][number] {
  return {
    kind: "agent",
    updatedAt: 1,
    ...row,
  } as SessionsListResult["sessions"][number];
}

describe("resolveControlUiDocumentTitle", () => {
  it("keeps the base title when no session is selected", () => {
    expect(resolveControlUiDocumentTitle({ sessionKey: "" })).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("includes the active session label before the app title", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:session-1",
        sessionsResult: sessionsResult([
          sessionRow({ key: "agent:main:session-1", label: "Release triage" }),
        ]),
      }),
    ).toBe("Release triage - OpenClaw Control");
  });

  it("uses chat session picker metadata when the sessions tab has not loaded", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:alpha",
        chatSessionPickerResult: sessionsResult([
          sessionRow({ key: "agent:alpha", label: "Alpha planning" }),
        ]),
      }),
    ).toBe("Alpha planning - OpenClaw Control");
  });

  it("uses active session metadata preserved from a searched picker selection", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:older:searched",
        activeSessionTitleRow: sessionRow({
          key: "agent:older:searched",
          label: "Searched archive session",
        }),
      }),
    ).toBe("Searched archive session - OpenClaw Control");
  });

  it("prefers fresh sessions tab metadata over stale chat session picker metadata", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:alpha",
        sessionsResult: sessionsResult([sessionRow({ key: "agent:alpha", label: "Fresh name" })]),
        chatSessionPickerResult: sessionsResult([
          sessionRow({ key: "agent:alpha", label: "Stale name" }),
        ]),
      }),
    ).toBe("Fresh name - OpenClaw Control");
  });

  it("uses the display name when a custom label is not set", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:session-2",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:session-2",
            kind: "direct",
            displayName: "Model debugging",
          }),
        ]),
      }),
    ).toBe("Model debugging - OpenClaw Control");
  });

  it("prefers refreshed picker metadata over preserved active session metadata", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:older:searched",
        activeSessionTitleRow: sessionRow({
          key: "agent:older:searched",
          label: "Old archive title",
        }),
        chatSessionPickerResult: sessionsResult([
          sessionRow({
            key: "agent:older:searched",
            label: "Refreshed archive title",
          }),
        ]),
      }),
    ).toBe("Refreshed archive title - OpenClaw Control");
  });

  it("prefixes cron labels in document titles", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:cron:abc-123",
        sessionsResult: sessionsResult([
          sessionRow({ key: "agent:main:cron:abc-123", label: "daily-briefing" }),
        ]),
      }),
    ).toBe("Cron: daily-briefing - OpenClaw Control");
  });

  it("prefixes subagent display names in document titles", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:subagent:abc-123",
        sessionsResult: sessionsResult([
          sessionRow({ key: "agent:main:subagent:abc-123", displayName: "Task Runner" }),
        ]),
      }),
    ).toBe("Subagent: Task Runner - OpenClaw Control");
  });

  it("keeps the base title when label metadata is the raw session key", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:imessage:direct:+49123456789",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:imessage:direct:+49123456789",
            label: "agent:main:imessage:direct:+49123456789",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("keeps the base title when display name metadata is the raw session key", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:imessage:direct:+49123456789",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:imessage:direct:+49123456789",
            displayName: "agent:main:imessage:direct:+49123456789",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("does not use generated direct session display names as titles", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:telegram:direct:42",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:telegram:direct:42",
            kind: "direct",
            displayName: "openclaw-tui",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("does not use generated account-scoped direct display names as titles", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:telegram:atlas:direct:814912386",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:telegram:atlas:direct:814912386",
            kind: "direct",
            displayName: "Atlas Contact",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("does not use origin-derived display names for bound channel sessions with arbitrary keys", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:codex:acp:binding:line:default:test123",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:codex:acp:binding:line:default:test123",
            kind: "direct",
            chatType: "direct",
            origin: { label: "LINE Contact" },
            displayName: "LINE Contact",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("does not use generated group session display names as titles", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:whatsapp:group:123",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:whatsapp:group:123",
            kind: "group",
            displayName: "Neighbors",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("allows explicit labels on direct sessions", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:telegram:direct:42",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:telegram:direct:42",
            kind: "direct",
            chatType: "direct",
            origin: { label: "openclaw-tui" },
            label: "Support thread",
            displayName: "openclaw-tui",
          }),
        ]),
      }),
    ).toBe("Support thread - OpenClaw Control");
  });

  it("keeps the base title for rows without explicit safe title metadata", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "direct:whatsapp:+49123456789",
        sessionsResult: sessionsResult([
          sessionRow({ key: "direct:whatsapp:+49123456789", kind: "direct" }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });

  it("prefers exact session rows before legacy main aliases", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:main",
        sessionsResult: sessionsResult([
          sessionRow({ key: "main", label: "Legacy title" }),
          sessionRow({ key: "agent:main:main", label: "Canonical title" }),
        ]),
      }),
    ).toBe("Canonical title - OpenClaw Control");
  });

  it("keeps the base title until session metadata loads", () => {
    expect(resolveControlUiDocumentTitle({ sessionKey: "agent:main:main" })).toBe(
      CONTROL_UI_DOCUMENT_TITLE,
    );
  });
});

describe("syncControlUiDocumentTitle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the resolved active session title to document.title", () => {
    vi.stubGlobal("document", { title: CONTROL_UI_DOCUMENT_TITLE });

    syncControlUiDocumentTitle({
      sessionKey: "agent:main:session-1",
      sessionsResult: sessionsResult([
        sessionRow({ key: "agent:main:session-1", label: "PR work" }),
      ]),
    });

    expect(document.title).toBe("PR work - OpenClaw Control");
  });

  it("is safe outside a browser document", () => {
    vi.stubGlobal("document", undefined);

    expect(() => syncControlUiDocumentTitle({ sessionKey: "main" })).not.toThrow();
  });
});
