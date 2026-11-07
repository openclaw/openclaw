// Registers rollover cases inside the host-broker session suite.
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  initSessionState,
  readSessionStore as readSessionStoreFast,
  writeSessionStore as writeSessionStoreFast,
} from "./test/session.test-support.js";

function expectEntryFields(
  entry: SessionEntry,
  expected: Record<string, unknown>,
  label?: string,
): void {
  for (const [key, value] of Object.entries(expected)) {
    expect((entry as unknown as Record<string, unknown>)[key], label ?? key).toEqual(value);
  }
}

export function registerDailyRolloverTests(
  makeStorePath: (prefix: string) => Promise<string>,
): void {
  it.each([
    {
      name: "preserves user-set behavior and pinned state across an implicit daily stale rollover (#92562)",
      slug: "behavior",
      entry: {
        systemSent: true,
        thinkingLevel: "medium",
        verboseLevel: "on",
        traceLevel: "high",
        reasoningLevel: "low",
        ttsAuto: "always",
        pinnedAt: 123,
      },
      expected: {
        thinkingLevel: "medium",
        verboseLevel: "on",
        traceLevel: "high",
        reasoningLevel: "low",
        ttsAuto: "always",
        pinnedAt: 123,
      },
      persisted: true,
    },
    {
      name: "preserves a person-linked account across daily rollover",
      slug: "linked-account",
      entry: {
        authProfileOverride: "openai:linked-person",
        authProfileOverrideSource: "user-link" as const,
      },
      expected: {
        authProfileOverride: "openai:linked-person",
        authProfileOverrideSource: "user-link",
      },
      persisted: true,
    },
    {
      name: "clears an automatic account pin across daily rollover",
      slug: "automatic-account",
      entry: {
        authProfileOverride: "openai:fallback",
        authProfileOverrideSource: "auto" as const,
      },
      expected: {},
      absent: ["authProfileOverride", "authProfileOverrideSource"],
    },
    {
      name: "preserves usage footer mode across daily rollover",
      slug: "usage",
      entry: { responseUsage: "full" as const },
      expected: { responseUsage: "full" },
    },
    {
      name: "preserves explicit configured-default selection across daily rollover",
      slug: "explicit-default",
      entry: { modelOverrideSource: "default" as const },
      expected: { modelOverrideSource: "default" },
      persisted: true,
    },
    {
      name: "preserves user labels across dashboard session stale rollover (#101451)",
      slug: "label",
      sessionKey: "agent:main:dashboard:8c0b2b68-05e1-4b25-a8c2-ef6f43a01f77",
      chatType: "direct",
      entry: { label: "Other", autoLabel: "Device", displayName: "Dashboard Chat" },
      expected: { label: "Other", autoLabel: "Device", displayName: "Dashboard Chat" },
      persisted: true,
    },
    {
      name: "clears an auto-fallback model override on an implicit daily stale rollover (#90119)",
      slug: "fallback",
      entry: {
        systemSent: true,
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o-mini",
      },
      expected: {},
      absent: ["modelOverride", "providerOverride", "modelOverrideSource"],
    },
    {
      name: "preserves behavior overrides while clearing an auto-fallback model override on one implicit daily rollover (#92562)",
      slug: "mixed",
      entry: {
        systemSent: true,
        thinkingLevel: "medium",
        providerOverride: "minimax",
        modelOverride: "m2.7",
        modelOverrideFallbackOriginProvider: "openai",
        modelOverrideFallbackOriginModel: "gpt-4o-mini",
      },
      expected: { thinkingLevel: "medium" },
      absent: ["modelOverride", "providerOverride"],
    },
  ])("$name", async (scenario) => {
    const storePath = await makeStorePath(`openclaw-daily-rollover-${scenario.slug}-`);
    const sessionKey =
      "sessionKey" in scenario && typeof scenario.sessionKey === "string"
        ? scenario.sessionKey
        : `agent:main:discord:channel:daily-rollover-${scenario.slug}`;
    const existingSessionId = `session-before-daily-reset-${scenario.slug}`;
    const staleStartedAt = Date.now() - 48 * 60 * 60 * 1000;
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: staleStartedAt,
        sessionStartedAt: staleStartedAt,
        lastInteractionAt: staleStartedAt,
        ...scenario.entry,
      },
    });

    const result = await initSessionState({
      ctx: {
        RawBody: "hello again",
        ChatType: "chatType" in scenario ? scenario.chatType : "channel",
        SessionKey: sessionKey,
      },
      cfg: {
        session: { store: storePath, reset: { mode: "daily", atHour: 4 } },
      } as OpenClawConfig,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expectEntryFields(result.sessionEntry, scenario.expected, scenario.name);
    if ("absent" in scenario && Array.isArray(scenario.absent)) {
      for (const field of scenario.absent) {
        expect(
          (result.sessionEntry as unknown as Record<string, unknown>)[field],
          scenario.name,
        ).toBeUndefined();
      }
    }
    if ("persisted" in scenario && scenario.persisted) {
      expectEntryFields(
        expectDefined(readSessionStoreFast(storePath)[sessionKey], "stored session"),
        scenario.expected,
        scenario.name,
      );
    }
  });
}
