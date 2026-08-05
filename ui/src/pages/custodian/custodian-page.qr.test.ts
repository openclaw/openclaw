/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { buildSystemAgentSessionInvalidatedErrorDetails } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

const QR_DATA_URL = "data:image/png;base64,AAAA";
const SESSION_ID = "qr-session";

function qrResult(expiresInMs = 60_000, stepId = "qr-step") {
  return {
    sessionId: SESSION_ID,
    reply: "Scan this code, then continue.",
    action: "none" as const,
    wizardInputPending: true,
    step: {
      id: stepId,
      type: "qr" as const,
      title: "Link a device",
      message: "Scan this QR code, then continue.",
      qrDataUrl: QR_DATA_URL,
      expiresInMs,
      executor: "client" as const,
    },
  };
}

function terminalResult(reply = "Signal is configured.", sessionId = SESSION_ID) {
  return { sessionId, reply, action: "none" as const };
}

describe("custodian QR wizard step", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders and acknowledges QR through the generic wizard answer", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Device linked."));
    const { page } = await mountPage(createContext(request).context);

    await waitForFast(() => expect(page.querySelector(".wizard-step__qr")).not.toBeNull());
    const image = page.querySelector<HTMLImageElement>(".wizard-step__qr");
    expect(image?.getAttribute("src")).toBe(QR_DATA_URL);
    expect(page.textContent).not.toContain(QR_DATA_URL);

    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    expect(request.mock.calls[1]?.[1]).toEqual({
      sessionId: SESSION_ID,
      wizardAnswer: { stepId: "qr-step", value: true },
    });
    await waitForFast(() =>
      expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false),
    );
  });

  it("cancels QR setup through the typed wizard answer", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Signal setup cancelled."));
    const { page } = await mountPage(createContext(request).context);

    await waitForFast(() => expect(page.querySelector(".wizard-step__qr")).not.toBeNull());
    const cancelButton = Array.from(
      page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step .btn"),
    ).find((button) => button.textContent?.trim() === "Cancel");
    cancelButton?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));

    expect(request.mock.calls[1]?.[1]).toEqual({
      sessionId: SESSION_ID,
      wizardAnswer: { stepId: "qr-step", value: false },
    });
    await waitForFast(() => expect(page.textContent).toContain("Signal setup cancelled."));
  });

  it("keeps polling when acknowledgement advances directly to another QR", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(qrResult(60_000, "qr-step-2"))
      .mockResolvedValueOnce(terminalResult("Both devices are linked."));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(page.store.messages.some((message) => message.step?.id === "qr-step-2")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    expect(request.mock.calls[2]?.[1]).toEqual({
      sessionId: SESSION_ID,
      pollStepId: "qr-step-2",
    });
  });

  it("keeps the QR and resumes polling when Continue was definitely unsent", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockRejectedValueOnce(new Error("socket send failed"))
      .mockResolvedValueOnce(terminalResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    const continueButton = page.querySelector<HTMLButtonElement>(
      ".custodian__wizard-step .btn.primary",
    );
    await waitForFast(() => expect(continueButton?.disabled).toBe(false));
    continueButton?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;

    expect(page.querySelector<HTMLImageElement>(".wizard-step__qr")?.src).toContain(QR_DATA_URL);
    expect(page.store.messages.some((message) => message.step?.qrDataUrl === QR_DATA_URL)).toBe(
      true,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("scrubs the QR but keeps polling when Continue delivery is uncertain", async () => {
    vi.useFakeTimers();
    let rejectAcknowledgement!: (error: Error) => void;
    const acknowledgement = new Promise<never>((_resolve, reject) => {
      rejectAcknowledgement = reject;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockImplementationOnce(
        async (
          _method: string,
          _params: unknown,
          options?: { onSent?: () => void },
        ): Promise<never> => {
          options?.onSent?.();
          return await acknowledgement;
        },
      )
      .mockResolvedValueOnce(terminalResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    const continueButton = page.querySelector<HTMLButtonElement>(
      ".custodian__wizard-step .btn.primary",
    );
    await waitForFast(() => expect(continueButton?.disabled).toBe(false));
    continueButton?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(0);
    await waitForFast(() => expect(page.querySelector(".wizard-step__qr")).toBeNull());
    await waitForFast(() =>
      expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false),
    );
    rejectAcknowledgement(new Error("connection closed after send"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.store.error).toContain("connection closed after send");
    expect(page.querySelector('[role="alert"]')).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
    expect(page.store.hasUnresolvedQuestion()).toBe(false);
    expect(page.store.error).toBeNull();
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears a failed acknowledgement error when recovery returns the active QR", async () => {
    vi.useFakeTimers();
    let rejectAcknowledgement!: (error: Error) => void;
    const acknowledgement = new Promise<never>((_resolve, reject) => {
      rejectAcknowledgement = reject;
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockImplementationOnce(
        async (
          _method: string,
          _params: unknown,
          options?: { onSent?: () => void },
        ): Promise<never> => {
          options?.onSent?.();
          return await acknowledgement;
        },
      )
      .mockResolvedValueOnce(qrResult(30_000));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    const continueButton = page.querySelector<HTMLButtonElement>(
      ".custodian__wizard-step .btn.primary",
    );
    await waitForFast(() => expect(continueButton?.disabled).toBe(false));
    continueButton?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    rejectAcknowledgement(new Error("connection closed after send"));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.store.error).toContain("connection closed after send");

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.store.error).toBeNull();
    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.querySelector<HTMLImageElement>(".wizard-step__qr")?.src).toContain(QR_DATA_URL);
  });

  it("polls without duplicating the QR transcript and shows owner completion", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(qrResult(30_000))
      .mockResolvedValueOnce(terminalResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    const messageCount = page.store.messages.length;
    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.store.messages).toHaveLength(messageCount);
    const qrMessages = page.store.messages.filter((message) => message.step?.id === "qr-step");
    expect(qrMessages).toHaveLength(1);
    expect(qrMessages[0]?.step?.expiresInMs).toBe(30_000);

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.store.messages).toHaveLength(messageCount + 1);
    expect(page.textContent).toContain("Signal is configured.");
    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("retries a transient QR poll failure", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockRejectedValueOnce(new Error("temporary poll failure"))
      .mockResolvedValueOnce(terminalResult());
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("resumes polling a pending QR step after a same-client reconnect", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult());
    const { context, setGatewaySnapshot } = createContext(request, ["openclaw.chat"], {
      connectionId: "connection-1",
      deviceId: "device-1",
      processInstanceId: "gateway-process-1",
    });
    setGatewaySnapshot({
      selfUser: { id: "profile-1", email: "owner@example.com" },
    });
    const hello = context.gateway.snapshot.hello;
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    setGatewaySnapshot({ phase: "reconnecting", hello: null, selfUser: null });
    await page.updateComplete;
    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);

    setGatewaySnapshot({
      phase: "connected",
      hello,
      selfUser: { id: "profile-1", email: "owner@example.com" },
    });
    await page.updateComplete;
    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
  });

  it("keeps a device-owned QR through late presence and a same-user reconnect", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult());
    const { context, setGatewaySnapshot } = createContext(request, ["openclaw.chat"], {
      connectionId: "connection-1",
      deviceId: "device-1",
      processInstanceId: "gateway-process-1",
    });
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".wizard-step__qr")).not.toBeNull();

    setGatewaySnapshot({
      selfUser: { id: "profile-1", email: "owner@example.com" },
    });
    await page.updateComplete;

    expect(request).toHaveBeenCalledOnce();
    expect(page.querySelector(".wizard-step__qr")).not.toBeNull();

    const hello = context.gateway.snapshot.hello;
    if (!hello) {
      throw new Error("expected connected Gateway hello");
    }
    setGatewaySnapshot({
      client: {
        request,
        authenticatedDeviceId: "device-2",
      } as unknown as GatewayBrowserClient,
      hello: {
        ...hello,
        server: { connId: "connection-2" },
      },
      selfUser: { id: "profile-1", email: "owner@example.com" },
    });
    await page.updateComplete;

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
  });

  it("starts fresh when late presence identifies a different user", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Fresh session ready.", "replacement-session"));
    const { context, setGatewaySnapshot } = createContext(request, ["openclaw.chat"], {
      connectionId: "connection-1",
      deviceId: "device-1",
      processInstanceId: "gateway-process-1",
    });
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);

    setGatewaySnapshot({ selfUser: { id: "profile-1", email: "owner@example.com" } });
    await page.updateComplete;
    const hello = context.gateway.snapshot.hello;
    if (!hello) {
      throw new Error("expected connected Gateway hello");
    }
    setGatewaySnapshot({
      client: {
        request,
        authenticatedDeviceId: "device-2",
      } as unknown as GatewayBrowserClient,
      hello: { ...hello, server: { connId: "connection-2" } },
      selfUser: { id: "profile-2", email: "other@example.com" },
    });
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("pollStepId");
    expect(request.mock.calls[1]?.[1]?.sessionId).not.toBe(SESSION_ID);
    expect(page.textContent).toContain("Fresh session ready.");
  });

  it("resumes the same QR session after a client replacement", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult());
    const { context, setGatewaySnapshot } = createContext(request, ["openclaw.chat"], {
      connectionId: "connection-1",
      deviceId: "device-1",
      deviceToken: "device-token-1",
      processInstanceId: "gateway-process-1",
    });
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);
    const hello = context.gateway.snapshot.hello;
    if (!hello) {
      throw new Error("expected connected Gateway hello");
    }

    setGatewaySnapshot({
      client: {
        request,
        authenticatedDeviceId: "device-1",
      } as unknown as GatewayBrowserClient,
      hello: {
        ...hello,
        auth: {
          role: "operator",
          scopes: ["operator.admin"],
          deviceToken: "device-token-2",
        },
        server: { connId: "connection-2" },
      },
    });
    await page.updateComplete;
    expect(page.querySelector(".wizard-step__qr")).toBeNull();

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({ sessionId: SESSION_ID, pollStepId: "qr-step" });
    expect(page.textContent).toContain("Signal is configured.");
  });

  it.each([
    {
      name: "starts fresh when a connection-owned QR loses its owner",
      nextProcessInstanceId: "gateway-process-1",
    },
    {
      name: "starts fresh when a device-owned QR loses its Gateway process",
      deviceId: "device-1",
      deviceToken: "device-token-1",
      nextProcessInstanceId: "gateway-process-2",
    },
  ])("$name", async ({ deviceId, deviceToken, nextProcessInstanceId }) => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockResolvedValueOnce(terminalResult("Fresh session ready.", "replacement-session"));
    const { context, setGatewaySnapshot } = createContext(request, ["openclaw.chat"], {
      connectionId: "connection-1",
      ...(deviceId ? { deviceId } : {}),
      ...(deviceToken ? { deviceToken } : {}),
      processInstanceId: "gateway-process-1",
    });
    const { page } = await mountPage(context);
    await vi.advanceTimersByTimeAsync(0);
    const hello = context.gateway.snapshot.hello;
    if (!hello) {
      throw new Error("expected connected Gateway hello");
    }

    setGatewaySnapshot({
      client: {
        request,
        authenticatedDeviceId: deviceId ?? null,
      } as unknown as GatewayBrowserClient,
      hello: {
        ...hello,
        server: { connId: "connection-2" },
        snapshot: { processInstanceId: nextProcessInstanceId },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("pollStepId");
    expect(request.mock.calls[1]?.[1]?.sessionId).not.toBe(SESSION_ID);
    expect(page.textContent).toContain("Fresh session ready.");
  });

  it("scrubs the QR and starts fresh after poll session invalidation", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "QR session was evicted.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce(terminalResult("Fresh session ready.", "replacement-session"));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("pollStepId");
    expect(request.mock.calls[2]?.[1]?.sessionId).not.toBe(SESSION_ID);
    expect(page.textContent).toContain("Fresh session ready.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("ignores a stale acknowledgement callback after session rotation", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult())
      .mockRejectedValueOnce(
        new GatewayProtocolRequestError({
          code: "INVALID_REQUEST",
          message: "QR session was evicted.",
          details: buildSystemAgentSessionInvalidatedErrorDetails(),
        }),
      )
      .mockResolvedValueOnce(terminalResult("Fresh session ready.", "replacement-session"));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("pollStepId");
    expect(page.textContent).toContain("Fresh session ready.");
  });

  it("scrubs expired image bytes while a result poll is still pending", async () => {
    vi.useFakeTimers();
    const pendingPoll = new Promise<never>(() => {});
    const request = vi.fn().mockResolvedValueOnce(qrResult(2_000)).mockReturnValueOnce(pendingPoll);
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2_000);
    await page.updateComplete;

    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.textContent).toContain("This QR code expired.");
    expect(page.store.messages.some((message) => message.step?.qrDataUrl)).toBe(false);
  });

  it("keeps polling and offers typed cancellation after QR expiry", async () => {
    vi.useFakeTimers();
    const pendingResult = {
      sessionId: SESSION_ID,
      reply: "Setup is still finishing the QR attempt.",
      action: "none" as const,
      wizardInputPending: true,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(qrResult(1_000))
      .mockResolvedValueOnce(pendingResult)
      .mockResolvedValueOnce(pendingResult)
      .mockResolvedValueOnce(terminalResult("Signal setup cancelled."));
    const { page } = await mountPage(createContext(request).context);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_000);
    await page.updateComplete;
    expect(page.querySelector(".wizard-step__qr")).toBeNull();
    expect(page.textContent).toContain("This QR code expired.");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(request.mock.calls.filter((call) => call[1]?.pollStepId === "qr-step")).toHaveLength(2);

    const cancelButton = Array.from(
      page.querySelectorAll<HTMLButtonElement>(".custodian__wizard-step .btn"),
    ).find((button) => button.textContent?.trim() === "Cancel");
    cancelButton?.click();
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(4));
    expect(request.mock.calls[3]?.[1]).toEqual({
      sessionId: SESSION_ID,
      wizardAnswer: { stepId: "qr-step", value: false },
    });
    await waitForFast(() => expect(page.textContent).toContain("Signal setup cancelled."));
  });
});
