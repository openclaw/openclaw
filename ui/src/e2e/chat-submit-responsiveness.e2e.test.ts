import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

let page: Page;
let composer: Locator;
let gateway: Awaited<ReturnType<typeof installMockGateway>>;

suite.define(() => {
  beforeEach(async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    page = await context.newPage();
    gateway = await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}chat`);
    composer = page.locator(".agent-chat__composer-combobox textarea");
  });
  it("keeps a durably admitted removal retired across the browser input yield", async () => {
    await composer.fill("discard before delivery");
    await gateway.setOnline(false);
    await gateway.closeLatest();
    await composer.evaluate((element) => {
      const ActualMessageChannel = MessageChannel;
      window.MessageChannel = class extends ActualMessageChannel {
        constructor() {
          super();
          const post = this.port2.postMessage.bind(this.port2);
          this.port2.postMessage = () => {
            window.MessageChannel = ActualMessageChannel;
            element.setAttribute("data-admission-yielded", "true");
            document.addEventListener("resume-admitted-send", () => post(undefined), {
              once: true,
            });
          };
        }
      };
    });

    await composer.press("Enter");
    await expect.poll(() => composer.getAttribute("data-admission-yielded")).toBe("true");
    const queued = page.locator(".chat-queue__item", { hasText: "discard before delivery" });
    await queued.waitFor();
    await queued.locator(".chat-queue__remove").evaluate((button: HTMLElement) => button.click());
    await queued.waitFor({ state: "detached" });
    await composer.fill("next draft stays mine");
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          document.dispatchEvent(new Event("resume-admitted-send"));
          const { port1, port2 } = new MessageChannel();
          port1.addEventListener(
            "message",
            () => {
              port1.close();
              port2.close();
              resolve();
            },
            { once: true },
          );
          port1.start();
          port2.postMessage(undefined);
        }),
    );
    expect({
      alerts: await page.getByRole("alert").allTextContents(),
      draft: await composer.inputValue(),
      queued: await page.locator(".chat-queue__item").count(),
      sent: await gateway.getRequests("chat.send"),
    }).toEqual({ alerts: [], draft: "next draft stays mine", queued: 0, sent: [] });
  });

  it("returns to browser input before starting durable chat delivery", async () => {
    await composer.fill("first prompt");
    await composer.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const order: string[] = [];
      const record = (value: string) => {
        order.push(value);
        textarea.dataset.submitTaskOrder = JSON.stringify(order);
      };
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the socket receiver below.
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (
          typeof data === "string" &&
          (JSON.parse(data) as { method?: string }).method === "chat.send"
        ) {
          record(`transport:${textarea.value}`);
        }
        Reflect.apply(send, this, [data]);
      };
      textarea.addEventListener(
        "keydown",
        function onSubmit(event) {
          // Meta+Enter emits a modifier keydown first; only submission queues the next input.
          if (event.key !== "Enter") {
            return;
          }
          textarea.removeEventListener("keydown", onSubmit, true);
          const { port1, port2 } = new MessageChannel();
          port1.addEventListener(
            "message",
            () => {
              port1.close();
              port2.close();
              textarea.value = "second prompt";
              textarea.dispatchEvent(
                new InputEvent("input", {
                  bubbles: true,
                  data: "second prompt",
                  inputType: "insertText",
                }),
              );
              record("next-input-task");
            },
            { once: true },
          );
          port1.start();
          port2.postMessage(undefined);
        },
        { capture: true },
      );
    });

    await composer.press("Meta+Enter");
    const request = await gateway.waitForRequest("chat.send");
    expect(request.params).toMatchObject({ message: "first prompt" });
    await expect
      .poll(() => composer.getAttribute("data-submit-task-order"))
      .toBe(JSON.stringify(["next-input-task", "transport:second prompt"]));
    expect(await composer.inputValue()).toBe("second prompt");
  });
});
