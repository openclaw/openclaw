/* @vitest-environment jsdom */

import { createRouter, definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../../test/helpers/promise.js";
import type { RouteId } from "../../../app-route-paths.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { RouterOutlet } from "../../../app/router-outlet.tsx";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  click,
  contextWithRequest,
  createAgentTarget,
  DIARY,
  diary,
  emptyReply,
  STATUS,
} from "./memory-panel.test-support.ts";
import { AgentMemoryPanel } from "./memory-panel.tsx";
import { installDreamingViewTestTranslations } from "./view.test-helpers.ts";
import "../../../lib/toast-host.tsx";

const restoreTranslations = installDreamingViewTestTranslations();
afterAll(() => restoreTranslations());
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["maintenance", "confirmation", "config"] as const)(
  "leaves Dreaming through RouterOutlet while %s is pending",
  async (operation) => {
    const pathname = "/systems";
    const pending = deferred<unknown>();
    const method = "doctor.memory.backfillDreamDiary";
    const request = vi.fn((name: string) =>
      name === method
        ? pending.promise
        : name === DIARY
          ? diary("Sample main diary")
          : emptyReply(name),
    );
    const context = contextWithRequest(request);
    vi.mocked(context.runtimeConfig.openFile).mockImplementation(async () => {
      await pending.promise;
    });
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);
    await toastHost.updateComplete;
    context.emit({
      hello: gatewayHelloForMethods(
        [STATUS, DIARY, method, "config.patch"],
        ["operator.read", "operator.write", "operator.admin"],
      ),
    });
    context.setConfig({});
    vi.mocked(context.runtimeConfig.patch).mockImplementation(async () => {
      await pending.promise;
      return true;
    });
    const memoryModule = {
      renderSolid: () =>
        createComponent(AgentMemoryPanel, { initialAgentTarget: createAgentTarget("main") }),
    };
    const destinationModule = {
      renderSolid: () => {
        const body = document.createElement("p");
        body.textContent = `Dreaming destination: ${pathname}`;
        return body;
      },
    };
    const router = createRouter<RouteId, ApplicationContext, typeof memoryModule>({
      routes: [
        definePage({
          id: "agents",
          path: "/settings/agents/:agentId/:panel",
          component: () => memoryModule,
        }),
        definePage({ id: "systems", path: "/systems", component: () => destinationModule }),
      ],
    });
    Object.assign(context, { router });
    const provider = createSolidApplicationContextProvider(context);
    const page = mountSolid(
      () => createComponent(RouterOutlet, { router, retryContext: context }),
      {
        wrapper: provider.wrapper,
      },
    );
    let navigation: Promise<unknown> | undefined;
    try {
      await router.navigate(
        "agents",
        context,
        {},
        {
          pathname: "/settings/agents/main/memory",
          search: "",
          hash: "",
        },
      );
      await waitForSolid(() =>
        expect(
          page.container.querySelector<HTMLButtonElement>(".dreams__phase-toggle")?.disabled,
        ).toBe(false),
      );
      const oldHost = page.container.querySelector("openclaw-agent-memory-panel")!;
      if (operation === "maintenance") {
        click(page.container, "#dreams-tab-advanced");
        const backfill = [...page.container.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Backfill",
        );
        expect(backfill).toBeDefined();
        await waitForSolid(() => expect(backfill!.disabled).toBe(false));
        backfill!.click();
        await waitForSolid(() => expect(request).toHaveBeenCalledWith(method, { agentId: "main" }));
        await waitForSolid(() => expect(page.container.textContent).toContain("Working…"));
      } else if (operation === "config") {
        click(page.container, "#dreams-tab-diary");
        click(page.container, "#dream-diary-tab-wiki");
        const openConfig = page.container.querySelector<HTMLButtonElement>(
          ".dreams-diary__empty-actions .btn",
        )!;
        openConfig.click();
        await waitForSolid(() => {
          expect(openConfig.disabled).toBe(true);
          expect(openConfig.getAttribute("aria-busy")).toBe("true");
          expect(context.runtimeConfig.openFile).toHaveBeenCalledOnce();
        });
      } else {
        click(page.container, ".dreams__phase-toggle");
        click(page.container, ".exec-approval-actions button:last-child");
        await waitForSolid(() => expect(page.container.textContent).toContain("Saving…"));
        await waitForSolid(() => expect(context.runtimeConfig.patch).toHaveBeenCalledOnce());
      }
      navigation = router.navigate(
        "systems",
        context,
        {},
        {
          pathname,
          search: "",
          hash: "",
        },
      );
      await waitForSolid(() => {
        expect(page.container.textContent).toContain(`Dreaming destination: ${pathname}`);
        expect(oldHost.isConnected).toBe(false);
        expect(page.container.querySelector("openclaw-agent-memory-panel")).toBeNull();
        expect(page.container.querySelector(".exec-approval-actions")).toBeNull();
      });
      pending.reject(new Error("Late Dreaming failure"));
      await Promise.allSettled([pending.promise, navigation]);
      await waitForSolid(() => {
        expect(page.container.textContent).toContain(`Dreaming destination: ${pathname}`);
        expect(page.container.querySelector("openclaw-agent-memory-panel")).toBeNull();
        expect(page.container.querySelector('[role="alert"]')).toBeNull();
        expect(page.container.textContent).not.toContain("Late Dreaming failure");
        expect(toastHost.textContent).not.toContain("Late Dreaming failure");
      });
    } finally {
      pending.resolve({ written: 1 });
      await Promise.allSettled([pending.promise, navigation]);
      page.unmount();
      router.stop();
    }
  },
);
