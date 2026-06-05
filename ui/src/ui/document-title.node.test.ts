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
    count: sessions.length,
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

  it("uses the display name when a custom label is not set", () => {
    expect(
      resolveControlUiDocumentTitle({
        sessionKey: "agent:main:session-2",
        sessionsResult: sessionsResult([
          sessionRow({ key: "agent:main:session-2", displayName: "Model debugging" }),
        ]),
      }),
    ).toBe("Model debugging - OpenClaw Control");
  });

  it("falls back to the readable session key name until session metadata loads", () => {
    expect(resolveControlUiDocumentTitle({ sessionKey: "agent:main:main" })).toBe(
      "Main Session - OpenClaw Control",
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
