import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveCliExecutionAuthProfileId } from "../agents/cli-execution-auth.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearObservedProviderUsageWindows,
  noteClaudeCodeSessionRoute,
} from "../infra/provider-usage.observed.js";
import type { ProviderUsageSnapshot } from "../infra/provider-usage.types.js";
import { selectStatusUsageEntry, sessionRunsOnHostClaudeLogin } from "./status-usage-entry.js";

type ResolveAuthProfileId = typeof resolveCliExecutionAuthProfileId;

const SESSION_KEY = "agent:main:main";

const anthropic: ProviderUsageSnapshot = {
  provider: "anthropic",
  displayName: "Claude",
  windows: [{ label: "5h", usedPercent: 70 }],
};
const claudeCode: ProviderUsageSnapshot = {
  provider: "claude-cli",
  displayName: "Claude Code",
  windows: [{ label: "5h", usedPercent: 20, resetAt: 900_000 }],
  observedAt: 1,
};

describe("selectStatusUsageEntry", () => {
  it("never lets the host's Claude Code row stand in for the session's provider", () => {
    expect(selectStatusUsageEntry([claudeCode])).toBeUndefined();
    expect(selectStatusUsageEntry([claudeCode, anthropic])).toBe(anthropic);
  });

  it("keeps the first provider row, as before, whatever id a plugin reports", () => {
    const plugin = { ...anthropic, provider: "plugin-usage" } as ProviderUsageSnapshot;
    expect(selectStatusUsageEntry([plugin, anthropic])).toBe(plugin);
  });
});

describe("sessionRunsOnHostClaudeLogin", () => {
  beforeEach(() => {
    noteClaudeCodeSessionRoute(SESSION_KEY, true);
  });
  afterEach(() => {
    clearObservedProviderUsageWindows();
  });

  const config = {} as OpenClawConfig;
  const check = (
    sessionEntry: Partial<SessionEntry> | undefined,
    resolveAuthProfileId: () => string | undefined,
    statusProvider = "claude-cli",
  ) =>
    sessionRunsOnHostClaudeLogin({
      statusProvider,
      authProvider: "anthropic",
      modelId: "claude-opus-4-7",
      sessionKey: SESSION_KEY,
      sessionEntry: sessionEntry as SessionEntry | undefined,
      config,
      agentId: "main",
      agentDir: "/agent",
      resolveAuthProfileId: vi.fn(resolveAuthProfileId),
    });

  it("asks the run's own resolver with the session's pin and Claude Code binding", () => {
    const resolveAuthProfileId = vi.fn<ResolveAuthProfileId>(() => undefined);
    const sessionEntry = {
      authProfileOverride: "anthropic:work",
      authProfileOverrideSource: "user",
      cliSessionBindings: { "claude-cli": { sessionId: "cli-1", authProfileId: "anthropic:work" } },
    } as unknown as SessionEntry;
    expect(
      sessionRunsOnHostClaudeLogin({
        statusProvider: "claude-cli",
        authProvider: "anthropic",
        modelId: "claude-opus-4-7",
        sessionKey: SESSION_KEY,
        sessionEntry,
        config,
        agentId: "main",
        agentDir: "/agent",
        resolveAuthProfileId,
      }),
    ).toBe(true);
    expect(resolveAuthProfileId).toHaveBeenCalledWith(
      expect.objectContaining({
        cliExecutionProvider: "claude-cli",
        authProfileProvider: "anthropic",
        agentDir: "/agent",
        selected: { authProfileId: "anthropic:work", authProfileIdSource: "user" },
        sessionBinding: expect.objectContaining({
          sessionId: "cli-1",
          authProfileId: "anthropic:work",
        }),
      }),
    );
  });

  it("passes the profile the agent's configured model pins, unless the session has a user pin", () => {
    const configured = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-7@anthropic:api" } } },
    } as OpenClawConfig;
    const selectedFor = (sessionEntry: Partial<SessionEntry> | undefined, modelId: string) => {
      const resolveAuthProfileId = vi.fn<ResolveAuthProfileId>(() => undefined);
      sessionRunsOnHostClaudeLogin({
        statusProvider: "claude-cli",
        authProvider: "anthropic",
        modelId,
        sessionKey: SESSION_KEY,
        sessionEntry: sessionEntry as SessionEntry | undefined,
        config: configured,
        agentId: "main",
        agentDir: "/agent",
        resolveAuthProfileId,
      });
      return resolveAuthProfileId.mock.calls[0]?.[0].selected;
    };
    expect(selectedFor(undefined, "claude-opus-4-7")).toEqual({
      authProfileId: "anthropic:api",
      authProfileIdSource: "user",
    });
    // An automatic session pick does not outrank the configured profile.
    expect(
      selectedFor(
        { authProfileOverride: "anthropic:auto", authProfileOverrideSource: "auto" },
        "claude-opus-4-7",
      ),
    ).toEqual({ authProfileId: "anthropic:api", authProfileIdSource: "user" });
    expect(
      selectedFor(
        { authProfileOverride: "anthropic:mine", authProfileOverrideSource: "user" },
        "claude-opus-4-7",
      ),
    ).toEqual({ authProfileId: "anthropic:mine", authProfileIdSource: "user" });
    // The pin belongs to the configured model only.
    expect(selectedFor(undefined, "claude-sonnet-4-6")).toEqual({
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("is the host login only when the run would forward no auth profile", () => {
    expect(check(undefined, () => undefined)).toBe(true);
    // An automatically picked stored profile is another account too.
    expect(check(undefined, () => "anthropic:default")).toBe(false);
  });

  it("is not the host login when the run would refuse the pinned profile", () => {
    expect(
      check({ authProfileOverride: "openai:work" }, () => {
        throw new Error("cannot use auth profile");
      }),
    ).toBe(false);
  });

  it("needs the runner to have admitted the session's latest Claude Code turn", () => {
    const resolveAuthProfileId = vi.fn<ResolveAuthProfileId>(() => undefined);
    const admitted = () =>
      sessionRunsOnHostClaudeLogin({
        statusProvider: "claude-cli",
        authProvider: "anthropic",
        modelId: "claude-opus-4-7",
        sessionKey: SESSION_KEY,
        config,
        agentId: "main",
        agentDir: "/agent",
        resolveAuthProfileId,
      });
    // A backend credential, settings, or config directory the runner saw.
    noteClaudeCodeSessionRoute(SESSION_KEY, false);
    expect(admitted()).toBe(false);
    // No Claude Code turn since the Gateway started or usage was cleared.
    clearObservedProviderUsageWindows();
    expect(admitted()).toBe(false);
    expect(resolveAuthProfileId).not.toHaveBeenCalled();
  });

  it("excludes paired nodes and sessions that do not run on Claude Code", () => {
    expect(check({ execHost: "node" }, () => undefined)).toBe(false);
    expect(check(undefined, () => undefined, "anthropic")).toBe(false);
  });
});
