import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { createSessionActivity } from "./session-activity-owner.ts";
import "../../styles/base.css";
import "../../styles/components.css";
import "../../styles/settings.css";
import "../../styles/settings-controls.css";
import "../../styles/activity.css";
import { mountSolid, props as activityProps } from "./session-activity-view.test-harness.ts";
import { renderSessionActivityView } from "./session-activity-view.tsx";

const renderSessionActivityViewSolid = mountSolid<ReturnType<typeof activityProps>>(
  renderSessionActivityView,
  (input) => createSolidApplicationContextProvider(input.context).wrapper,
);

it.each([
  { personId: null, width: 900 },
  { personId: "person", width: 900 },
  { personId: null, width: 390 },
  { personId: "person", width: 390 },
])(
  "keeps content stable through passive refresh and explicit Retry ($personId, $width px)",
  async ({ personId, width }, { onTestFinished }) => {
    const container = document.body.appendChild(document.createElement("div"));
    onTestFinished(() => container.remove());
    await page.viewport(width, 700);
    const props = activityProps({ filters: { personId, query: "", time: "7d" } });
    Object.assign(props.context.gateway.snapshot, { hello: null, client: null, phase: "stopped" });
    Object.assign(props.result!, {
      people: [{ identity: { type: "profile", id: "person" }, label: "Person", sessionCount: 0 }],
      activityPulse: {
        since: new Date(2026, 8, 20).getTime(),
        until: new Date(2026, 8, 28).getTime(),
        buckets: Array.from({ length: 8 }, () => 0),
        sessions: 0,
        started: 0,
        running: 0,
      },
    });
    renderSessionActivityViewSolid(props, container);
    const main = container.querySelector<HTMLElement>(".activity-feed__main")!;
    const contentSelector = personId ? "[data-activity-identity]" : ".activity-pulse";
    const content = main.querySelector<HTMLElement>(contentSelector)!;
    const feedback = container.querySelector(".activity-feed__feedback")!;
    expect(getComputedStyle(feedback)).toMatchObject({ minHeight: "32px" });
    const top = content.getBoundingClientRect().top;
    expect(content.getBoundingClientRect().height).toBeGreaterThan(0);

    for (const loading of [true, false, true, false]) {
      renderSessionActivityViewSolid({ ...props, loading }, container);
      expect(Math.abs(content.getBoundingClientRect().top - top)).toBeLessThan(1);
      expect(main.textContent).not.toContain("Loading");
    }

    const request = vi.fn().mockResolvedValue(props.result);
    const client = { request } as unknown as GatewayBrowserClient;
    let retryCompletion = Promise.resolve();
    const controller = createSessionActivity(() =>
      renderSessionActivityViewSolid(
        {
          ...props,
          ...controller,
          onRetry: () => {
            retryCompletion = controller.load(client, props.filters, "retry");
          },
        },
        container,
      ),
    );
    try {
      await controller.load(client, props.filters);
      expect(controller.loading).toBe(false);
      const retained = container.querySelector<HTMLElement>(contentSelector)!;
      const retainedTop = retained.getBoundingClientRect().top;
      const expectStable = () =>
        expect(Math.abs(retained.getBoundingClientRect().top - retainedTop)).toBeLessThan(1);
      request.mockRejectedValueOnce(new Error("Refresh failed"));
      await controller.load(client, props.filters, "refresh");
      expect(controller.error).toBe("Refresh failed");
      expectStable();
      const retryButton = () => feedback.querySelector<HTMLButtonElement>("button");
      expect(retryButton()?.textContent?.trim()).toBe("Retry");
      const pending = createDeferred<NonNullable<typeof props.result>>();
      request.mockReturnValueOnce(pending.promise);
      retryButton()!.click();
      expect(controller.loading).toBe(true);
      expect(request).toHaveBeenCalledTimes(3);
      expect(container.querySelector('[role="status"]')?.textContent).toContain("Refreshing");
      expect(retryButton()?.disabled).toBe(true);
      expectStable();
      pending.reject(new Error("Retry failed"));
      await retryCompletion;
      expect(controller.error).toBe("Retry failed");
      expect(retryButton()?.disabled).toBe(false);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("Retry failed");
      expectStable();
      const recovered = createDeferred<NonNullable<typeof props.result>>();
      request.mockReturnValueOnce(recovered.promise);
      retryButton()!.click();
      expect(controller.retrying).toBe(true);
      expect(request).toHaveBeenCalledTimes(4);
      expect(retryButton()?.disabled).toBe(true);
      recovered.resolve(props.result!);
      await retryCompletion;
      expect(controller.loading).toBe(false);
      expect(retryButton()).toBeNull();
      expect(container.textContent).not.toContain("Refreshing");
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expectStable();
    } finally {
      controller.dispose();
    }

    renderSessionActivityViewSolid({ ...props, result: undefined, loading: true }, container);
    expect(
      container.querySelector('.activity-feed__loading [role="status"]')?.textContent,
    ).toContain("Loading");
  },
);
