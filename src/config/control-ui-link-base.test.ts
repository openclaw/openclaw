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
  it.each([
    ["disabled", { enabled: false }, undefined],
    ["normalized", { basePath: " /control/// " }, `${origin}/control`],
    ["under the cap", { basePath: `/${"a".repeat(176)}` }, `${origin}/${"a".repeat(176)}`],
    ["over the cap", { basePath: `/${"a".repeat(178)}` }, undefined],
  ] as const)("handles %s Control UI bases", (_name, config, expected) => {
    expect(linkBase(config)).toBe(expected);
  });
  it("omits session links without a public Gateway origin", () => {
    expect(resolveControlUiSessionLinkBase({ gateway: {} })).toBeUndefined();
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
        { gateway: { publicOrigin: origin, controlUi: { basePath: " /control/// " } } },
        { jobId: "job /?&", runId: "cron:job /?&:123" },
      ),
    ).toBe(`${origin}/control/automations?job=job+%2F%3F%26&run=cron%3Ajob+%2F%3F%26%3A123`);
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
