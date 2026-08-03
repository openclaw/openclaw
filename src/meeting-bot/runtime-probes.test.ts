import { describe, expect, it, vi } from "vitest";
import { MeetingPlatformAdapter } from "./platform-adapter.js";
import { createMeetingRuntimeProbes } from "./runtime-probes.js";
import type { MeetingBrowserHealth } from "./session-types.js";

type Mode = "agent" | "bidi" | "transcribe";
type Transport = "chrome" | "chrome-node";
type Health = MeetingBrowserHealth & {
  transcriptLines?: number;
  lastCaptionAt?: string;
  lastCaptionText?: string;
};
type Session = {
  id: string;
  chrome?: {
    launched: boolean;
    browserTab?: { targetId?: string };
    health?: Health;
  };
};
type Request = {
  url: string;
  mode?: Mode;
  transport?: Transport;
  timeoutMs?: number;
  message?: string;
  agentId?: string;
};
type Config = {
  defaultMode: Mode;
  chrome: { joinTimeoutMs: number };
  chromeNode: { node?: string };
};

const cases = [
  {
    name: "Google Meet",
    invalidRequestName: "Error",
    session: { id: "google", chrome: { launched: true } } satisfies Session,
    shouldWaitForListening: (session: Session) => Boolean(session.chrome?.launched),
    waitsForListening: true,
    waitsWithoutBrowserTarget: true,
  },
  {
    name: "Teams",
    invalidRequestName: "Error",
    session: {
      id: "teams",
      chrome: { browserTab: { targetId: "teams-tab" }, launched: false },
    } satisfies Session,
    shouldWaitForListening: (session: Session) =>
      Boolean(session.chrome?.launched || session.chrome?.browserTab?.targetId),
    waitsForListening: true,
    waitsWithoutBrowserTarget: true,
  },
  {
    name: "Zoom",
    invalidRequestName: "ZoomInvalidRequest",
    session: {
      id: "zoom",
      chrome: { browserTab: { targetId: "zoom-tab" }, launched: false },
    } satisfies Session,
    shouldWaitForListening: (session: Session) => Boolean(session.chrome?.browserTab?.targetId),
    waitsForListening: true,
    waitsWithoutBrowserTarget: false,
  },
] as const;

describe.each(cases)("$name meeting runtime probe parity", (testCase) => {
  const createProbes = () =>
    createMeetingRuntimeProbes<Config, Mode, Transport, Health, Session, Request>({
      defaultSpeechMessage: `Say exactly: ${testCase.name} speech test complete.`,
      invalidRequest: (message) => {
        const error = new Error(message);
        error.name = testCase.invalidRequestName;
        return error;
      },
      resolveTimeoutMs: () => 5,
      shouldWaitForListening: testCase.shouldWaitForListening,
      talkBackMode: MeetingPlatformAdapter.isTalkBackMode,
    });

  it("preserves the platform invalid-request contract", async () => {
    const probes = createProbes();
    await expect(
      probes.testSpeech(
        {
          config: { defaultMode: "agent", chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
          resolveAgentId: () => "main",
          list: () => [],
          join: vi.fn(),
          isReusable: () => false,
          hasHealthHandle: () => false,
          refreshHealth: vi.fn(),
          refreshCaptionHealth: vi.fn(),
        },
        { url: "https://example.test/meeting", mode: "transcribe" },
      ),
    ).rejects.toMatchObject({
      name: testCase.invalidRequestName,
      message: "test_speech requires mode: agent or bidi",
    });
  });

  it("waits for listening when the joined session has a browser target", async () => {
    const probes = createProbes();
    const refreshCaptionHealth = vi.fn(async () => undefined);
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [],
      join: vi.fn(async () => ({ session: testCase.session })),
      isReusable: () => false,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await probes.testListening(context, {
      url: "https://example.test/meeting",
      mode: "transcribe",
      timeoutMs: 5,
    });

    if (testCase.waitsForListening) {
      expect(refreshCaptionHealth).toHaveBeenCalled();
    } else {
      expect(refreshCaptionHealth).not.toHaveBeenCalled();
    }
  });

  it("preserves platform policy when the joined session has no browser target", async () => {
    const probes = createProbes();
    const refreshCaptionHealth = vi.fn(async () => undefined);
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [],
      join: vi.fn(async () => ({
        session: { id: `${testCase.name.toLowerCase()}-untracked`, chrome: { launched: true } },
      })),
      isReusable: () => false,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await expect(
      probes.testListening(context, {
        url: "https://example.test/meeting",
        mode: "transcribe",
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      listenTimedOut: testCase.waitsWithoutBrowserTarget,
      listenVerified: false,
    });
    if (testCase.waitsWithoutBrowserTarget) {
      expect(refreshCaptionHealth).toHaveBeenCalled();
    } else {
      expect(refreshCaptionHealth).not.toHaveBeenCalled();
    }
  });

  it("returns a fresh manual action without refreshing the new session", async () => {
    const probes = createProbes();
    const initialAction = {
      reason: `${testCase.name.toLowerCase()}-fresh-action`,
      message: "Complete the requested browser action.",
    };
    const session = {
      id: `${testCase.name.toLowerCase()}-fresh-action`,
      chrome: {
        ...testCase.session.chrome,
        health: { manualAction: initialAction },
      },
    } satisfies Session;
    const refreshCaptionHealth = vi.fn(async () => {
      session.chrome.health = {
        manualAction: {
          reason: `${testCase.name.toLowerCase()}-replacement-action`,
          message: "This redundant refresh replaced the useful action.",
        },
      };
    });
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [],
      join: vi.fn(async () => ({ session })),
      isReusable: () => false,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await expect(
      probes.testListening(context, {
        url: "https://example.test/meeting",
        mode: "transcribe",
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      createdSession: true,
      listenTimedOut: false,
      listenVerified: false,
      manualAction: initialAction,
    });
    expect(refreshCaptionHealth).not.toHaveBeenCalled();
  });

  it("returns a fresh manual action discovered while reusing a checked session", async () => {
    const probes = createProbes();
    const freshAction = {
      reason: `${testCase.name.toLowerCase()}-fresh-reused-action`,
      message: "Complete the newly discovered browser action.",
    };
    const session = {
      id: `${testCase.name.toLowerCase()}-fresh-reused-action`,
      chrome: {
        ...testCase.session.chrome,
        health: {},
      },
    } satisfies Session;
    const refreshCaptionHealth = vi.fn(async () => {
      session.chrome.health = {
        manualAction: {
          reason: `${testCase.name.toLowerCase()}-replacement-action`,
          message: "This redundant refresh replaced the fresh action.",
        },
      };
    });
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [session],
      join: vi.fn(async () => {
        session.chrome.health = { manualAction: freshAction };
        return { browserHealthChecked: true, session };
      }),
      isReusable: () => true,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await expect(
      probes.testListening(context, {
        url: "https://example.test/meeting",
        mode: "transcribe",
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      createdSession: false,
      listenTimedOut: false,
      listenVerified: false,
      manualAction: freshAction,
    });
    expect(refreshCaptionHealth).not.toHaveBeenCalled();
  });

  it("preserves legacy join behavior when browser health metadata is omitted", async () => {
    const probes = createProbes();
    const freshAction = {
      reason: `${testCase.name.toLowerCase()}-legacy-fresh-action`,
      message: "Complete the newly discovered browser action.",
    };
    const session = {
      id: `${testCase.name.toLowerCase()}-legacy-fresh-action`,
      chrome: {
        ...testCase.session.chrome,
        health: {},
      },
    } satisfies Session;
    const refreshCaptionHealth = vi.fn(async () => {
      session.chrome.health = {
        manualAction: {
          reason: `${testCase.name.toLowerCase()}-legacy-replacement-action`,
          message: "This compatibility-breaking refresh replaced the fresh action.",
        },
      };
    });
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [session],
      join: vi.fn(async () => {
        session.chrome.health = { manualAction: freshAction };
        return { session };
      }),
      isReusable: () => true,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await expect(
      probes.testListening(context, {
        url: "https://example.test/meeting",
        mode: "transcribe",
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      createdSession: false,
      listenTimedOut: false,
      listenVerified: false,
      manualAction: freshAction,
    });
    expect(refreshCaptionHealth).not.toHaveBeenCalled();
  });

  it("returns an authoritative reused-session action without another refresh", async () => {
    const probes = createProbes();
    const authoritativeAction = {
      reason: `${testCase.name.toLowerCase()}-authoritative-action`,
      message: "The lifecycle refresh already produced the actionable failure.",
    };
    const session = {
      id: `${testCase.name.toLowerCase()}-authoritative-action`,
      chrome: {
        ...testCase.session.chrome,
        health: { manualAction: authoritativeAction },
      },
    } satisfies Session;
    const refreshCaptionHealth = vi.fn(async () => {
      await new Promise<never>(() => {});
    });
    const context = {
      config: { defaultMode: "agent" as const, chrome: { joinTimeoutMs: 5 }, chromeNode: {} },
      resolveAgentId: () => "main",
      list: () => [session],
      join: vi.fn(async () => ({
        browserHealthChecked: false,
        manualActionIsAuthoritative: true,
        session,
      })),
      isReusable: () => true,
      hasHealthHandle: () => false,
      refreshHealth: vi.fn(),
      refreshCaptionHealth,
    };

    await expect(
      probes.testListening(context, {
        url: "https://example.test/meeting",
        mode: "transcribe",
        timeoutMs: 5,
      }),
    ).resolves.toMatchObject({
      createdSession: false,
      listenTimedOut: false,
      listenVerified: false,
      manualAction: authoritativeAction,
    });
    expect(refreshCaptionHealth).not.toHaveBeenCalled();
  });
});
