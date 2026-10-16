import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CronPage lifecycle", () => {
  it("loads catalog choices after a detached route mount is attached", async () => {
    const fallback = createRequest();
    const request = vi.fn(async (method: string) =>
      method === "models.list"
        ? { models: [{ id: "catalog-choice", provider: "fixture", name: "Catalog choice" }] }
        : fallback(method),
    );
    const gateway = createGateway(createTestGatewayClient(request), true);
    gateway.emitSnapshot({ hello: operatorHello(["operator.admin"]) });
    const page = createPage(createContext(gateway), { render: true, attach: false });
    try {
      expect(request).not.toHaveBeenCalled();
      document.body.append(page);
      page.querySelector<HTMLButtonElement>('[data-test-id="cron-new-task"]')!.click();
      await waitForCronPage(() =>
        expect(page.querySelector("#cron-payload-model-picker")).not.toBeNull(),
      );
      page.querySelector<HTMLButtonElement>("#cron-payload-model-picker")!.click();
      await waitForCronPage(() =>
        expect(
          page.querySelector('[role="option"][data-value="fixture/catalog-choice"]'),
        ).not.toBeNull(),
      );
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toHaveLength(1);
    } finally {
      page.remove();
    }
  });
});
