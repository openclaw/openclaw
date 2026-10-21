import { describe, expect, it } from "vitest";
import {
  resolveControlUiAutomationRunUrl,
  resolveControlUiSessionLinkBase,
  resolveControlUiPublicSessionUrl,
} from "./control-ui-link-base.js";

const origin = "http://127.0.0.1:18789";
const linkBase = (controlUi: { enabled?: boolean; basePath?: string }) =>
  resolveControlUiSessionLinkBase({ gateway: { publicOrigin: origin, controlUi } });

describe("resolveControlUiSessionLinkBase", () => {
  it("omits session links without a public Gateway origin", () => {
    expect(resolveControlUiSessionLinkBase({ gateway: {} })).toBeUndefined();
  });

  it("omits session links when the Control UI is disabled", () => {
    expect(linkBase({ enabled: false })).toBeUndefined();
  });

  it("joins a valid public origin with the normalized Control UI base path", () => {
    expect(
      resolveControlUiSessionLinkBase({
        gateway: {
          publicOrigin: "http://127.0.0.1:18789",
          controlUi: { basePath: " /control/// " },
        },
      }),
    ).toBe("http://127.0.0.1:18789/control");
  });

  it("preserves a session link base just under the hard cap", () => {
    const basePath = `/${"a".repeat(176)}`;
    const expected = `${origin}${basePath}`;
    expect(expected).toHaveLength(199);
    expect(linkBase({ basePath })).toBe(expected);
  });

  it("omits a session link base with an oversized Control UI base path", () => {
    expect(linkBase({ basePath: `/${"a".repeat(178)}` })).toBeUndefined();
  });
});

describe("resolveControlUiAutomationRunUrl", () => {
  it("omits automation links without a public Gateway origin", () => {
    expect(
      resolveControlUiAutomationRunUrl({ gateway: {} }, { jobId: "daily-report" }),
    ).toBeUndefined();
  });

  it("joins the normalized Control UI base path and encodes job and run identifiers", () => {
    expect(
      resolveControlUiAutomationRunUrl(
        {
          gateway: {
            publicOrigin: "https://gateway.example.com",
            controlUi: { basePath: " /control/// " },
          },
        },
        { jobId: "job /?&", runId: "cron:job /?&:123" },
      ),
    ).toBe(
      "https://gateway.example.com/control/automations?job=job+%2F%3F%26&run=cron%3Ajob+%2F%3F%26%3A123",
    );
  });

  it("omits the run query parameter when no run identifier is available", () => {
    expect(
      resolveControlUiAutomationRunUrl(
        { gateway: { publicOrigin: "https://gateway.example.com" } },
        { jobId: "daily-report" },
      ),
    ).toBe("https://gateway.example.com/automations?job=daily-report");
  });
});

describe("resolveControlUiPublicSessionUrl", () => {
  const config = { gateway: { publicOrigin: "https://gateway.example" } };
  const entry = {
    sessionId: "session-1",
    updatedAt: 1,
    publicShare: { id: "a".repeat(48), sessionId: "session-1", createdAt: 1 },
  };
  const session = { sessionKey: "agent:main:main", sessionId: "session-1", agentId: "main" };
  it("uses the canonical anonymous chat route for the published generation", () => {
    expect(resolveControlUiPublicSessionUrl(config, { ...session, entry })).toBe(
      "https://gateway.example/chat/main",
    );
  });
  it.each([
    { name: "missing", entry: undefined },
    { name: "private", entry: { ...entry, publicShare: undefined } },
    { name: "incognito", entry: { ...entry, incognito: true as const } },
    { name: "stale", entry: { ...entry, sessionId: "session-2" } },
  ])("omits $name sessions", ({ entry: current }) => {
    expect(
      resolveControlUiPublicSessionUrl(config, { ...session, entry: current }),
    ).toBeUndefined();
  });
});
