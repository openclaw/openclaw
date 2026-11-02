import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isRealtimeVoiceWakeNameRequired as wakeNameRequired,
  resolveRealtimeVoiceBargeIn as bargeIn,
  resolveRealtimeVoiceInterruptResponseOnInputAudio as interruptOnAudio,
  resolveRealtimeVoiceMinBargeInAudioEndMs as minAudioEndMs,
  resolveRealtimeVoiceSessionPolicy,
} from "./realtime-session-policy.js";

const cfg = {
  agents: { entries: { "agent-1": { name: "Clawbot", identity: { name: "Molty" } } } },
} satisfies OpenClawConfig;

function resolve(overrides: Partial<Parameters<typeof resolveRealtimeVoiceSessionPolicy>[0]> = {}) {
  return resolveRealtimeVoiceSessionPolicy({
    isAgentProxy: true,
    supportsActivationNameGating: true,
    configuredToolPolicy: undefined,
    configuredConsultPolicy: undefined,
    requireWakeName: undefined,
    configuredWakeNames: undefined,
    cfg,
    agentId: "agent-1",
    ...overrides,
  });
}

it("defaults agent-proxy sessions to owner consults and adaptive wake names", () => {
  expect(resolve()).toStrictEqual({
    handlesAgentConsult: false,
    toolPolicy: "owner",
    consultToolsAllow: undefined,
    consultPolicy: "always",
    wakeNamePolicy: "automatic",
    wakeNames: ["openclaw", "clawbot", "molty"],
    autoRespondToAudio: false,
  });
});

it.each([undefined, "always"] as const)(
  "resolves native delegation policy: %s",
  (configuredConsultPolicy) => {
    const native = () =>
      resolve({
        supportsActivationNameGating: undefined,
        capabilities: {
          transports: ["gateway-relay"],
          inputAudioFormats: [],
          outputAudioFormats: [],
          handlesAgentConsult: true,
        },
        configuredToolPolicy: "safe-read-only",
        configuredConsultPolicy,
      });
    if (configuredConsultPolicy === "always") {
      expect(native).toThrow("owns voice responses and delegation");
      return;
    }
    expect(native()).toMatchObject({
      handlesAgentConsult: true,
      toolPolicy: "safe-read-only",
      consultPolicy: "auto",
      wakeNamePolicy: "never",
      autoRespondToAudio: true,
    });
  },
);

it("preserves explicit wake-name overrides for capable agent-proxy sessions", () => {
  expect(resolve({ requireWakeName: true }).wakeNamePolicy).toBe("always");
  expect(resolve({ requireWakeName: false })).toMatchObject({
    wakeNamePolicy: "never",
    wakeNames: [],
  });
});

it("disables wake-name gating outside capable agent-proxy sessions", () => {
  const expectDisabled = (isAgentProxy: boolean, supportsActivationNameGating: boolean) => {
    expect(
      resolve({
        isAgentProxy,
        supportsActivationNameGating,
        configuredConsultPolicy: "auto",
        requireWakeName: true,
      }),
    ).toMatchObject({
      toolPolicy: isAgentProxy ? "owner" : "safe-read-only",
      consultPolicy: "auto",
      wakeNamePolicy: "never",
      wakeNames: [],
      autoRespondToAudio: true,
    });
  };
  expectDisabled(false, true);
  expectDisabled(true, false);
});

it("normalizes configured wake names instead of adding defaults", () => {
  const policy = resolve({
    configuredToolPolicy: "safe-read-only",
    configuredConsultPolicy: "auto",
    requireWakeName: true,
    configuredWakeNames: [" Claw ", "Claw Bot Helper", "claw"],
  });

  expect(policy.toolPolicy).toBe("safe-read-only");
  const tools = ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"];
  expect(policy.consultToolsAllow).toEqual(tools);
  expect(policy.wakeNames).toStrictEqual(["claw"]);
});

it("requires automatic wake names only for shared human participation", () => {
  expect(wakeNameRequired("always", 0)).toBe(true);
  expect(wakeNameRequired("automatic", 1)).toBe(false);
  expect(wakeNameRequired("automatic", 2)).toBe(true);
  expect(wakeNameRequired("never", 3)).toBe(false);
});

it("resolves provider-driven barge-in defaults", () => {
  expect([undefined, false, "false"].map(interruptOnAudio)).toEqual([true, false, true]);
  expect(bargeIn({ configuredBargeIn: false, interruptResponseOnInputAudio: true })).toBe(false);
  expect(bargeIn({ configuredBargeIn: undefined, interruptResponseOnInputAudio: false })).toBe(
    false,
  );
  expect([undefined, 0].map(minAudioEndMs)).toEqual([250, 0]);
});
