/* @vitest-environment jsdom */

import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";
import {
  readCustodianRecoveryForClient,
  reconcileCustodianRecoveryForClient,
} from "./custodian-recovery.ts";

const gatewayUrl = "ws://gateway.test/control";
const recoveryScope = "principal-a";
const recoveryClient = { recoveryScope, recoveryScopeReady: true } as never;
const recoveryCapabilities = [GATEWAY_SERVER_CAPS.SYSTEM_AGENT_CHAT_HISTORY_SESSION_RECOVERY];

describe("Custodian wizard reload recovery", () => {
  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("restores the sanitized active step and continues the same live session", async () => {
    let cancelled = false;
    let freshChatCount = 0;
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat.history") {
        if (params.sessionId === "live-wizard" && !cancelled) {
          return {
            turns: [
              { role: "user", text: "connect twitch", at: 1 },
              { role: "assistant", text: "Enter the secret.", at: 2 },
            ],
            activeWizard: {
              sessionId: "live-wizard",
              step: {
                id: "secret",
                type: "text",
                message: "Twitch client secret",
                sensitive: true,
              },
            },
          };
        }
        return { turns: [] };
      }
      if (method !== "openclaw.chat") {
        throw new Error(`unexpected method ${method}`);
      }
      if (params.wizardCancel) {
        cancelled = true;
        return {
          sessionId: "live-wizard",
          reply: "Twitch setup cancelled.",
          action: "none",
        };
      }
      freshChatCount += 1;
      return freshChatCount === 1
        ? {
            sessionId: "live-wizard",
            reply: "Enter the secret.",
            action: "none",
            sensitive: true,
            wizardInputPending: true,
            step: {
              id: "secret",
              type: "text",
              message: "Twitch client secret",
              sensitive: true,
            },
          }
        : { sessionId: "fresh-session", reply: "Fresh session ready.", action: "none" };
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      featureCapabilities: recoveryCapabilities,
      recoveryScope,
    });
    const first = await mountPage(context);
    await waitForFast(() =>
      expect(first.page.querySelector(".custodian__wizard-step")).not.toBeNull(),
    );
    expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toEqual({
      sessionId: "live-wizard",
    });

    first.provider.remove();
    const second = await mountPage(context);
    const recoveredInput = await waitForFast(() => {
      const input = second.page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[type="password"]',
      );
      expect(input).not.toBeNull();
      return input!;
    });
    expect(recoveredInput.value).toBe("");
    expect(second.page.textContent).toContain("Enter the secret.");
    expect(request.mock.calls.filter(([method]) => method === "openclaw.chat")).toHaveLength(1);

    second.page.querySelector<HTMLButtonElement>(".custodian__wizard-cancel")!.click();
    await waitForFast(() => expect(second.page.textContent).toContain("Twitch setup cancelled."));
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({
      sessionId: "live-wizard",
      wizardCancel: { stepId: "secret" },
    });
    expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toBeNull();

    second.provider.remove();
    const third = await mountPage(context);
    await waitForFast(() => expect(third.page.textContent).toContain("Fresh session ready."));
    expect(third.page.querySelector(".custodian__wizard-step")).toBeNull();
  });

  it("waits for the authenticated recovery scope before starting a fresh session", async () => {
    reconcileCustodianRecoveryForClient(
      recoveryClient,
      gatewayUrl,
      {
        sessionId: "delayed-scope-wizard",
        reply: "Enter the secret.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "secret",
          type: "text",
          message: "Twitch client secret",
          sensitive: true,
        },
      },
      "delayed-scope-wizard",
    );
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat.history") {
        expect(params.sessionId).toBe("delayed-scope-wizard");
        return {
          turns: [{ role: "assistant", text: "Enter the secret.", at: 1 }],
          activeWizard: {
            sessionId: "delayed-scope-wizard",
            step: {
              id: "secret",
              type: "text",
              message: "Twitch client secret",
              sensitive: true,
            },
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const harness = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      featureCapabilities: recoveryCapabilities,
      recoveryScope,
      recoveryScopeReady: false,
    });
    const mounted = await mountPage(harness.context);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(mounted.page.store.chatAvailable).toBe(false);

    harness.setRecoveryScopeReady(true);
    const recoveredInput = await waitForFast(() => {
      const input = mounted.page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[type="password"]',
      );
      expect(input).not.toBeNull();
      return input!;
    });
    expect(recoveredInput.value).toBe("");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.chat.history"]);
  });

  it("keeps a live recovery handle when its history lookup is temporarily unavailable", async () => {
    reconcileCustodianRecoveryForClient(
      recoveryClient,
      gatewayUrl,
      {
        sessionId: "retryable-wizard",
        reply: "Enter the secret.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "secret",
          type: "text",
          message: "Twitch client secret",
          sensitive: true,
        },
      },
      "retryable-wizard",
    );
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary history failure"))
      .mockResolvedValueOnce({
        turns: [{ role: "assistant", text: "Enter the secret.", at: 1 }],
        activeWizard: {
          sessionId: "retryable-wizard",
          step: {
            id: "secret",
            type: "text",
            message: "Twitch client secret",
            sensitive: true,
          },
        },
      });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      featureCapabilities: recoveryCapabilities,
      recoveryScope,
    });
    const { page } = await mountPage(context);

    const retry = await waitForFast(() => {
      const button = page.querySelector<HTMLButtonElement>('[role="alert"] button');
      expect(button).not.toBeNull();
      return button!;
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual(["openclaw.chat.history"]);
    expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toEqual({
      sessionId: "retryable-wizard",
    });

    retry.click();
    await waitForFast(() =>
      expect(page.querySelector('.custodian__wizard-step input[type="password"]')).not.toBeNull(),
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat.history",
    ]);
  });

  it("waits for a replacement client's recovery scope before rotating the session", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? { turns: [] }
        : {
            sessionId: "replacement-source-wizard",
            reply: "Enter the secret.",
            action: "none",
            wizardInputPending: true,
            step: {
              id: "secret",
              type: "text",
              message: "Twitch client secret",
              sensitive: true,
            },
          },
    );
    const replacementRequest = vi.fn().mockResolvedValue({
      sessionId: "replacement-fresh-session",
      reply: "Fresh session ready.",
      action: "none",
    });
    const replacementClient = {
      request: replacementRequest,
      recoveryScope,
      recoveryScopeReady: false,
    };
    const harness = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      featureCapabilities: recoveryCapabilities,
      recoveryScope,
    });
    const { page } = await mountPage(harness.context);
    await waitForFast(() => expect(request).toHaveBeenCalled());
    await waitForFast(() =>
      expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toEqual({
        sessionId: "replacement-source-wizard",
      }),
    );

    harness.setGatewaySnapshot({ client: replacementClient as unknown as GatewayBrowserClient });
    await Promise.resolve();
    expect(replacementRequest).not.toHaveBeenCalled();

    replacementClient.recoveryScopeReady = true;
    harness.setGatewaySnapshot({ client: replacementClient as unknown as GatewayBrowserClient });
    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(replacementRequest.mock.calls.map(([method]) => method)).toEqual(["openclaw.chat"]);
    expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toBeNull();
  });

  it("clears the old gateway recovery key when the connection URL changes", async () => {
    const request = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? { turns: [] }
        : {
            sessionId: "old-gateway-wizard",
            reply: "Enter the secret.",
            action: "none",
            wizardInputPending: true,
            step: {
              id: "secret",
              type: "text",
              message: "Twitch client secret",
              sensitive: true,
            },
          },
    );
    const replacementRequest = vi.fn(async (method: string) =>
      method === "openclaw.chat.history"
        ? { turns: [] }
        : { sessionId: "new-gateway-session", reply: "New gateway ready.", action: "none" },
    );
    const harness = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      featureCapabilities: recoveryCapabilities,
      recoveryScope,
    });
    await mountPage(harness.context);
    await waitForFast(() =>
      expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toEqual({
        sessionId: "old-gateway-wizard",
      }),
    );

    harness.setGatewayUrl("ws://other-gateway.test/control");
    harness.setGatewaySnapshot({
      client: {
        request: replacementRequest,
        recoveryScope,
        recoveryScopeReady: true,
      } as unknown as GatewayBrowserClient,
    });
    await waitForFast(() => expect(replacementRequest).toHaveBeenCalledTimes(2));

    expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toBeNull();
  });

  it("starts fresh without sending sessionId to a legacy history method", async () => {
    reconcileCustodianRecoveryForClient(
      recoveryClient,
      gatewayUrl,
      {
        sessionId: "legacy-wizard",
        reply: "Enter the secret.",
        action: "none",
        wizardInputPending: true,
        step: {
          id: "secret",
          type: "text",
          message: "Twitch client secret",
          sensitive: true,
        },
      },
      "legacy-wizard",
    );
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "openclaw.chat.history") {
        expect(params).not.toHaveProperty("sessionId");
        return { turns: [] };
      }
      if (method === "openclaw.chat") {
        return { sessionId: "legacy-fresh", reply: "Fresh session ready.", action: "none" };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const { context } = createContext(request, ["openclaw.chat", "openclaw.chat.history"], {
      featureCapabilities: [],
      recoveryScope,
    });
    const { page } = await mountPage(context);

    await waitForFast(() => expect(page.textContent).toContain("Fresh session ready."));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "openclaw.chat.history",
      "openclaw.chat",
    ]);
    expect(request.mock.calls[1]?.[1].sessionId).not.toBe("legacy-wizard");
    expect(readCustodianRecoveryForClient(recoveryClient, gatewayUrl)).toBeNull();
  });
});
