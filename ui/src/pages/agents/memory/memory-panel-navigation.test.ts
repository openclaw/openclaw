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
  requestFor,
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
    const destinationLabel = `Dreaming destination: ${pathname}`;
    const pending = deferred();
    const method = "doctor.memory.backfillDreamDiary";
    const request = requestFor({
      [method]: () => pending.promise,
      [DIARY]: () => diary("Sample main diary"),
    });
    const context = contextWithRequest(request);
    const config = context.runtimeConfig;
    vi.mocked(config.openFile).mockReturnValue(pending.promise);
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
    vi.mocked(config.patch).mockImplementation(() => pending.promise.then(() => true));
    const memoryModule = {
      renderSolid: () =>
        createComponent(AgentMemoryPanel, { initialAgentTarget: createAgentTarget("main") }),
    };
    const destinationModule = {
      renderSolid: () =>
        Object.assign(document.createElement("p"), { textContent: destinationLabel }),
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
    const { wrapper } = createSolidApplicationContextProvider(context);
    const page = mountSolid(
      () => createComponent(RouterOutlet, { router, retryContext: context }),
      { wrapper },
    );
    const { container } = page;
    const navigate = (id: RouteId, path: string) =>
      router.navigate(id, context, {}, { pathname: path, search: "", hash: "" });
    const expectDestination = () => {
      expect(container.textContent).toContain(destinationLabel);
      expect(container.querySelector("openclaw-agent-memory-panel")).toBeNull();
    };
    let navigation: Promise<unknown> | undefined;
    try {
      await navigate("agents", "/settings/agents/main/memory");
      await waitForSolid(() =>
        expect(container.querySelector<HTMLButtonElement>(".dreams__phase-toggle")?.disabled).toBe(
          false,
        ),
      );
      const oldHost = container.querySelector("openclaw-agent-memory-panel")!;
      if (operation === "maintenance") {
        click(container, "#dreams-tab-advanced");
        const backfill = [...container.querySelectorAll("button")].find(
          (button) => button.textContent?.trim() === "Backfill",
        );
        expect(backfill).toBeDefined();
        await waitForSolid(() => expect(backfill!.disabled).toBe(false));
        backfill!.click();
        await waitForSolid(() => expect(request).toHaveBeenCalledWith(method, { agentId: "main" }));
        await waitForSolid(() => expect(container.textContent).toContain("Working…"));
      } else if (operation === "config") {
        click(container, "#dreams-tab-diary");
        click(container, "#dream-diary-tab-wiki");
        const openConfig = container.querySelector<HTMLButtonElement>(
          ".dreams-diary__empty-actions .btn",
        )!;
        openConfig.click();
        await waitForSolid(() => {
          expect(openConfig.disabled).toBe(true);
          expect(openConfig.getAttribute("aria-busy")).toBe("true");
          expect(config.openFile).toHaveBeenCalledOnce();
        });
      } else {
        click(container, ".dreams__phase-toggle");
        click(container, ".exec-approval-actions button:last-child");
        await waitForSolid(() => expect(container.textContent).toContain("Saving…"));
        await waitForSolid(() => expect(config.patch).toHaveBeenCalledOnce());
      }
      navigation = navigate("systems", pathname);
      await waitForSolid(() => {
        expectDestination();
        expect(oldHost.isConnected).toBe(false);
        expect(container.querySelector(".exec-approval-actions")).toBeNull();
      });
      pending.reject(new Error("Late Dreaming failure"));
      await Promise.allSettled([pending.promise, navigation]);
      await waitForSolid(() => {
        expectDestination();
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(container.textContent).not.toContain("Late Dreaming failure");
        expect(toastHost.textContent).not.toContain("Late Dreaming failure");
      });
    } finally {
      pending.resolve();
      await Promise.allSettled([pending.promise, navigation]);
      page.unmount();
      router.stop();
    }
  },
);
