import { beforeEach, describe, expect, it, vi } from "vitest";

const note = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({
  note,
}));

import { noteOpenAIOAuthTlsPrerequisites } from "./oauth-tls-preflight.js";

describe("noteOpenAIOAuthTlsPrerequisites", () => {
  beforeEach(() => {
    note.mockClear();
  });

  it("emits OAuth TLS prerequisite guidance when cert chain validation fails", async () => {
    const cause = new Error("unable to get local issuer certificate") as Error & { code?: string };
    cause.code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", fetchMock);

    try {
      await noteOpenAIOAuthTlsPrerequisites();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] as [string, string];
    expect(title).toBe("OAuth TLS prerequisites");
    expect(message).toContain("brew postinstall ca-certificates");
  });

  it("stays quiet when preflight succeeds", async () => {
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 400 })),
    );
    try {
      await noteOpenAIOAuthTlsPrerequisites();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
    expect(note).not.toHaveBeenCalled();
  });
});
