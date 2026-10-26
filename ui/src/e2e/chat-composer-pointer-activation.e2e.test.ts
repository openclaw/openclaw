import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer pointer controls",
  startServerBeforeBrowser: true,
});

type PointerTraceEntry = {
  centerHitLabel: string | null;
  eventTargetLabel: string | null;
  top: number;
  type: string;
};

type Gateway = Awaited<ReturnType<typeof installMockGateway>>;

async function withComposer(
  mobile: boolean,
  wide: boolean,
  run: (page: Page, gateway: Gateway) => Promise<void>,
  deferred = true,
): Promise<void> {
  return suite.withPage(
    {
      hasTouch: mobile,
      isMobile: mobile,
      serviceWorkers: "block",
      viewport: wide ? { width: 1280, height: 900 } : { width: 393, height: 852 },
    },
    async ({ page, context }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "OpenClaw",
        ...(deferred ? { deferredMethods: ["chat.send"] } : {}),
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.messages.subscribe");
      if (!wide) {
        const protocol = await context.newCDPSession(page);
        await protocol.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
      }
      await run(page, gateway);
    },
  );
}

async function expectComposerFocus(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page
        .locator(".agent-chat__input textarea")
        .evaluate((node) => document.activeElement === node),
    )
    .toBe(true);
}

async function expectSafeArea(page: Page): Promise<void> {
  // The injected 34px safe area plus the native composer's 10px bottom gap.
  await expect
    .poll(() =>
      page
        .locator(".agent-chat__composer-shell")
        .evaluate((node) => window.innerHeight - node.getBoundingClientRect().bottom),
    )
    .toBe(44);
}

async function streamReply(gateway: Gateway, afterRequest?: () => Promise<void>): Promise<string> {
  const sendRequest = await gateway.waitForRequest("chat.send");
  const runId =
    typeof sendRequest.params === "object" &&
    sendRequest.params !== null &&
    "idempotencyKey" in sendRequest.params
      ? String(sendRequest.params.idempotencyKey)
      : "";
  expect(runId).not.toBe("");
  expect(await gateway.getRequests("chat.send")).toHaveLength(1);
  await afterRequest?.();
  await gateway.resolveDeferred("chat.send");
  await gateway.emitGatewayEvent("chat", {
    deltaText: "Working on it.",
    message: {
      content: [{ text: "Working on it.", type: "text" }],
      role: "assistant",
      timestamp: Date.now(),
    },
    runId,
    sessionKey: "agent:main:main",
    state: "delta",
  });
  return runId;
}

async function activate(page: Page, button: Locator, touch: boolean): Promise<void> {
  await installPointerTrace(button);
  if (touch) {
    await button.tap();
  } else {
    await clickMouseAtCurrentCenter(page, button);
  }
  expectStablePointerActivation(await readPointerTrace(page));
}

async function narrowSendAndStop(touch: boolean): Promise<void> {
  await withComposer(touch, false, async (page, gateway) => {
    const textarea = page.locator(".agent-chat__input textarea");
    await textarea.fill(
      touch ? "Verify mobile safe-area touch controls" : "Verify narrow desktop pointer controls",
    );
    await textarea.focus();
    await expectSafeArea(page);
    const send = page.getByRole("button", { name: "Send message" });
    await expect.poll(() => send.isVisible()).toBe(true);
    await activate(page, send, touch);
    if (touch) {
      await expectComposerFocus(page);
    }
    const runId = await streamReply(gateway, touch ? undefined : () => expectComposerFocus(page));
    const stop = page.getByRole("button", { name: "Stop generating" });
    await expect.poll(() => stop.isVisible()).toBe(true);
    await textarea.focus();
    if (touch) {
      await expectSafeArea(page);
    }
    await activate(page, stop, touch);
    if (touch) {
      await expectComposerFocus(page);
    }
    const abortRequest = await gateway.waitForRequest("chat.abort");
    expect(abortRequest.params).toMatchObject({ runId, sessionKey: "agent:main:main" });
    if (touch) {
      await expect.poll(() => stop.count()).toBe(0);
    } else {
      await expectComposerFocus(page);
    }
  });
}

async function installPointerTrace(button: Locator): Promise<void> {
  await button.evaluate((element) => {
    const target = element as HTMLButtonElement;
    const trace: PointerTraceEntry[] = [];
    const traceWindow = window as Window & { openclawPointerTrace?: PointerTraceEntry[] };
    traceWindow.openclawPointerTrace = trace;
    const record = (event: Event) => {
      const pointerEvent = event as PointerEvent;
      const bounds = target.getBoundingClientRect();
      const hit = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      trace.push({
        centerHitLabel: hit?.closest("button")?.getAttribute("aria-label") ?? null,
        eventTargetLabel:
          event.target instanceof Element
            ? (event.target.closest("button")?.getAttribute("aria-label") ?? null)
            : null,
        top: bounds.top,
        type: event.type,
      });
    };
    for (const type of ["pointerdown", "pointerup", "click"]) {
      target.addEventListener(type, record);
    }
    // Android dismisses the software-keyboard focus as an action button is
    // activated. Model that transition explicitly because desktop Chromium
    // normally keeps a textarea focused for a synthetic touch tap.
    target.addEventListener(
      "pointerdown",
      (event) => {
        if ((event as PointerEvent).pointerType === "touch" && !event.defaultPrevented) {
          document.querySelector<HTMLTextAreaElement>(".agent-chat__input textarea")?.blur();
        }
      },
      { once: true },
    );
  });
}

async function readPointerTrace(page: Page): Promise<PointerTraceEntry[]> {
  return page.evaluate(
    () =>
      (window as Window & { openclawPointerTrace?: PointerTraceEntry[] }).openclawPointerTrace ??
      [],
  );
}

function expectStablePointerActivation(trace: PointerTraceEntry[]): void {
  const pointerDown = trace.find((entry) => entry.type === "pointerdown");
  const pointerUp = trace.find((entry) => entry.type === "pointerup");
  expect(trace, `pointer trace: ${JSON.stringify(trace)}`).toContainEqual(
    expect.objectContaining({ type: "click" }),
  );
  expect(pointerDown, `pointer trace: ${JSON.stringify(trace)}`).toBeDefined();
  expect(pointerUp, `pointer trace: ${JSON.stringify(trace)}`).toBeDefined();
  if (!pointerDown || !pointerUp) {
    return;
  }
  expect(
    Math.abs(pointerUp.top - pointerDown.top),
    `pointer trace: ${JSON.stringify(trace)}`,
  ).toBeLessThanOrEqual(1.5);
  expect(pointerUp.centerHitLabel).toBe(pointerDown.centerHitLabel);
  expect(pointerUp.eventTargetLabel).toBe(pointerDown.eventTargetLabel);
}

async function clickMouseAtCurrentCenter(page: Page, button: Locator): Promise<void> {
  const bounds = await button.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) {
    return;
  }
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

suite.define(() => {
  it("sends and stops without moving the action out from under an Android-like tap", async () => {
    await narrowSendAndStop(true);
  });

  it("sends and stops in a narrow desktop viewport without moving under the mouse", async () => {
    await narrowSendAndStop(false);
  });

  it("keeps wide desktop keyboard activation working", async () => {
    await withComposer(false, true, async (page, gateway) => {
      const textarea = page.locator(".agent-chat__input textarea");
      await textarea.fill("Verify desktop keyboard controls");
      await textarea.focus();
      const keyboardSend = page.getByRole("button", { name: "Send message" });
      await expect
        .poll(async () => {
          await page.keyboard.press("Tab");
          return keyboardSend.evaluate((node) => document.activeElement === node);
        })
        .toBe(true);
      await keyboardSend.press("Enter");
      const runId = await streamReply(gateway);
      const stop = page.getByRole("button", { name: "Stop generating" });
      await stop.focus();
      await stop.press("Space");
      const abortRequest = await gateway.waitForRequest("chat.abort");
      expect(abortRequest.params).toMatchObject({ runId, sessionKey: "agent:main:main" });
    });
  });

  it("does not send when a mouse gesture leaves the button before release", async () => {
    await withComposer(
      false,
      false,
      async (page, gateway) => {
        const textarea = page.locator(".agent-chat__input textarea");
        await textarea.fill("Do not send this draft");
        await textarea.focus();
        const send = page.getByRole("button", { name: "Send message" });
        const bounds = await send.boundingBox();
        expect(bounds).not.toBeNull();
        if (!bounds) {
          return;
        }
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x - 20, bounds.y - 20);
        await page.mouse.up();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => resolve());
            }),
        );
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        await expect.poll(() => textarea.inputValue()).toBe("Do not send this draft");
      },
      false,
    );
  });
});
