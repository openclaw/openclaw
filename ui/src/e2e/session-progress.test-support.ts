import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import { chatSessionListResponse, installMockGateway } from "./chat-flow.test-support.ts";

export const progressMethods = ["chat.metadata", "chat.startup", "progressCard.get"];

type Scenario = NonNullable<Parameters<typeof installMockGateway>[1]>;
type ProgressFixture = Omit<Scenario, "sessions"> & {
  sessionKey: string;
  sessions?: NonNullable<Parameters<typeof chatSessionListResponse>[0]>;
  row?: Record<string, unknown>;
  roster?: unknown;
  card?: unknown;
  progress?: unknown;
};
export function installProgressGateway(
  page: Page,
  { sessions, row, roster, card = null, progress = { card }, ...options }: ProgressFixture,
) {
  return installMockGateway(page, {
    featureMethods: progressMethods,
    ...options,
    methodResponses: {
      "progressCard.get": progress,
      "sessions.list":
        roster ??
        chatSessionListResponse(
          sessions ?? [
            { key: options.sessionKey, kind: "direct", label: "Progress", updatedAt: 1, ...row },
          ],
        ),
      ...options.methodResponses,
    },
  });
}

export const styles = (element: Locator, properties: string[], pseudo: string | null = null) =>
  element.evaluate(
    (el, options) => {
      const style = getComputedStyle(el, options.pseudo);
      return options.properties.map((property) => style.getPropertyValue(property));
    },
    { properties, pseudo },
  );

export async function updateCard<T extends { sessionKey: string; revision: number }>(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  card: T,
) {
  await gateway.setMethodResponse("progressCard.get", { card });
  await gateway.emitGatewayEvent("progressCard.changed", {
    sessionKey: card.sessionKey,
    revision: card.revision,
  });
}

export function parts(root: Page | Locator, placement: "details" | "composer") {
  const card = root.locator(`[data-progress-card-placement="${placement}"]`);
  return {
    card,
    summary: card.locator(".session-progress-card__summary"),
    body: card.locator(".session-progress-card__body"),
    steps: card.locator(".session-progress-card__step"),
    stepText: card.locator(".session-progress-card__step-text"),
  };
}
export async function expand(card: Locator) {
  await card.waitFor();
  if ((await card.getAttribute("open")) === null) {
    await card.locator("summary").click();
  }
}
export async function waitForIdle(thread: Locator) {
  await expect
    .poll(() =>
      thread.evaluate(async (el) => {
        const before = [el.scrollTop, el.scrollHeight, el.clientHeight];
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const after = [el.scrollTop, el.scrollHeight, el.clientHeight];
        return before.every((value, index) => value === after[index]);
      }),
    )
    .toBe(true);
}
