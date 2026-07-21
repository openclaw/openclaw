// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import {
  CONTROL_UI_DOCUMENT_TITLE,
  resolveControlUiDocumentTitle,
  syncControlUiDocumentTitle,
} from "./document-title.ts";

function sessionsResult(sessions: GatewaySessionRow[]): SessionsListResult {
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

function sessionRow(row: Partial<GatewaySessionRow> & { key: string }): GatewaySessionRow {
  return {
    kind: "unknown",
    updatedAt: 1,
    ...row,
  };
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

  it("uses preserved active session metadata when the refreshed list omits the session", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:searched",
        sessionsResult: sessionsResult([
          sessionRow({ key: "agent:main:other", label: "Other session" }),
        ]),
        activeSessionTitleRow: sessionRow({
          key: "agent:main:searched",
          label: "Searched archive",
        }),
      }),
    ).toBe("Searched archive - OpenClaw Control");
  });

  it("falls back to a non-generated display name", () => {
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

  it("does not use generated direct conversation display names as titles", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:telegram:direct:42",
        sessionsResult: sessionsResult([
          sessionRow({
            key: "agent:main:telegram:direct:42",
            kind: "direct",
            displayName: "Telegram Contact",
          }),
        ]),
      }),
    ).toBe(CONTROL_UI_DOCUMENT_TITLE);
  });
});

describe("syncControlUiDocumentTitle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing outside the browser", () => {
    expect(() =>
      syncControlUiDocumentTitle({
        sessionKey: "agent:main:session-1",
        sessionsResult: sessionsResult([
          sessionRow({ key: "agent:main:session-1", label: "Release triage" }),
        ]),
      }),
    ).not.toThrow();
  });

  it("updates document.title when it changes", () => {
    vi.stubGlobal("document", { title: CONTROL_UI_DOCUMENT_TITLE });

    syncControlUiDocumentTitle({
      sessionKey: "agent:main:session-1",
      sessionsResult: sessionsResult([
        sessionRow({ key: "agent:main:session-1", label: "Release triage" }),
      ]),
    });

    expect(document.title).toBe("Release triage - OpenClaw Control");
  });
});
