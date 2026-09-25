import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { resolveAssistantAttachmentAvailability } from "./chat-message-attachment-availability.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";

const panes: { container: HTMLElement; draw: () => void }[] = [];
afterEach(() => {
  for (const pane of panes.splice(0)) {
    render(nothing, pane.container);
    releaseChatMediaResourceSubscriber(pane.draw);
    pane.container.remove();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not let an aborted late renewal replace a newly mounted pane retry", async () => {
  vi.useFakeTimers();
  const startedAt = Date.parse("2026-09-19T12:00:00Z");
  vi.setSystemTime(startedAt);
  const source = "/tmp/openclaw/" + crypto.randomUUID() + ".png";
  const retry = createDeferred<Response>();
  let renewalSignal: AbortSignal | undefined;
  const ticket = (name: string) =>
    Response.json({
      available: true,
      mediaTicket: name,
      mediaTicketExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(ticket("original"))
    .mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          renewalSignal = init?.signal ?? undefined;
          renewalSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("retry superseded renewal", "AbortError")),
            { once: true },
          );
        }),
    )
    .mockReturnValueOnce(retry.promise);
  vi.stubGlobal("fetch", fetchMock);
  const options = { sessionKey: "renewal-retry-proof", agentId: "main" };
  const mount = () => {
    const container = document.createElement("div");
    document.body.append(container);
    const draw = () =>
      render(
        renderMessageImages([{ url: source, width: 1200, height: 800 }], {
          ...options,
          onRequestUpdate: draw,
        }),
        container,
      );
    panes.push({ container, draw });
    draw();
    return { container, draw };
  };
  const first = mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.container.querySelector("img")?.getAttribute("src")).toContain(
    "mediaTicket=original",
  );

  // A background tab resumes after its scheduled refresh, then a second pane
  // mounts after expiry while that late renewal is still in flight.
  vi.setSystemTime(startedAt + 59_000);
  first.draw();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  vi.setSystemTime(startedAt + 60_001);
  const second = mount();
  const retryButton = second.container.querySelector<HTMLButtonElement>(
    ".chat-assistant-attachment-card__retry",
  );
  expect(retryButton).not.toBeNull();
  retryButton!.click();
  expect(renewalSignal?.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(0);

  expect(resolveAssistantAttachmentAvailability(source, options).status).toBe("checking");
  expect(second.container.querySelector(".chat-assistant-attachment-card__retry")).toBeNull();
  retry.resolve(ticket("retry-success"));
  await vi.advanceTimersByTimeAsync(0);
  for (const { container } of panes) {
    expect(container.querySelector("img")?.getAttribute("src")).toContain(
      "mediaTicket=retry-success",
    );
  }
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
