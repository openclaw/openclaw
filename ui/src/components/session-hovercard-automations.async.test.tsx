/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { registerGitHubEnglish } from "../i18n/locales/en-github.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createCronJob, cronJobsListResponse } from "../test-helpers/cron.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
  type GatewayRequestMock,
} from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import {
  SessionHovercardAutomations,
  type SessionHovercardAutomation,
} from "./session-hovercard-automations.tsx";

registerEnglishCatalog(registerGitHubEnglish);

function connect(request: GatewayRequestMock) {
  const source = createApplicationGateway();
  source.publish({
    ...source.gateway.snapshot,
    phase: "connected",
    client: createTestGatewayClient(request),
  });
  return source;
}

const jobPage = (name: string, id = "job") =>
  cronJobsListResponse([createCronJob(id, name)], { limit: 20 });

function mount(source: ReturnType<typeof connect>) {
  const [automation, setAutomation] = createSignal<SessionHovercardAutomation>({
    gateway: source.gateway,
    sessionKey: "agent:main:example",
    agentId: "main",
    href: "/automations",
    navigate: () => {},
  });
  const view = mountSolid(() => <SessionHovercardAutomations automation={automation()} />);
  return {
    view,
    setAutomation,
    text: () => view.container.textContent,
    panel: () => view.container.querySelector(".session-hovercard__automations"),
    name: () => view.container.querySelector(".session-hovercard__automation-name"),
    retry: () => view.container.querySelector<HTMLButtonElement>("button.chip"),
  };
}

it("shows first-read readiness and retries a failed read through the cron owner", async () => {
  const first = Promise.withResolvers<unknown>();
  const retry = Promise.withResolvers<unknown>();
  const request = createGatewayRequestMock()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => retry.promise);
  const ui = mount(connect(request));
  await waitForSolid(() => {
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("true");
    expect(ui.text()).toContain("Loading automations…");
    expect(request).toHaveBeenCalledTimes(1);
  });
  first.reject(new Error("Synthetic cron read failure"));
  await waitForSolid(() => {
    expect(ui.text()).toContain("Couldn't load automations.");
    expect(ui.retry()?.disabled).toBe(false);
  });
  ui.retry()!.click();
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("true");
    expect(ui.text()).toContain("Loading automations…");
    expect(ui.text()).not.toContain("Couldn't load automations.");
    expect(ui.retry()).toBeNull();
  });
  retry.resolve(jobPage("Recovered automation", "recovered"));
  await waitForSolid(() => {
    expect(ui.name()?.textContent).toBe("Recovered automation");
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("false");
    expect(ui.retry()).toBeNull();
  });
});

it("retains detail and stays pending until the owner's queued event reload drains", async () => {
  const first = Promise.withResolvers<unknown>();
  const queued = Promise.withResolvers<unknown>();
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(jobPage("Original automation"))
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => queued.promise);
  const source = connect(request);
  const ui = mount(source);
  await waitForSolid(() => expect(ui.name()?.textContent).toBe("Original automation"));
  const detail = ui.name();
  source.publishEvent({ type: "event", event: "cron", payload: {} });
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(2);
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("true");
    expect(ui.name()).toBe(detail);
  });
  source.publishEvent({ type: "event", event: "cron", payload: {} });
  flush();
  expect(request).toHaveBeenCalledTimes(2);
  first.resolve(jobPage("Intermediate automation"));
  await waitForSolid(() => {
    expect(request).toHaveBeenCalledTimes(3);
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("true");
    expect(ui.name()).toBe(detail);
  });
  queued.resolve(jobPage("Final automation"));
  await waitForSolid(() => {
    expect(ui.name()?.textContent).toBe("Final automation");
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("false");
    expect(ui.name()).toBe(detail);
  });
});

it("retains the last good automation after a failed refresh and retries the owner", async () => {
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(jobPage("Original automation"))
    .mockRejectedValueOnce(new Error("Synthetic refresh failure"))
    .mockResolvedValueOnce(jobPage("Recovered automation"));
  const source = connect(request);
  const ui = mount(source);
  await waitForSolid(() => expect(ui.name()?.textContent).toBe("Original automation"));
  const detail = ui.name();
  source.publishEvent({ type: "event", event: "cron", payload: {} });
  await waitForSolid(() => {
    expect(ui.text()).toContain("Couldn't load automations.");
    expect(ui.name()).toBe(detail);
    expect(ui.name()?.textContent).toBe("Original automation");
    expect(ui.retry()?.disabled).toBe(false);
  });
  ui.retry()!.click();
  await waitForSolid(() => {
    expect(ui.name()).toBe(detail);
    expect(ui.name()?.textContent).toBe("Recovered automation");
    expect(ui.text()).not.toContain("Couldn't load automations.");
    expect(request).toHaveBeenCalledTimes(3);
  });
});

it("recovers a failed first read when the gateway scope is replaced", async () => {
  const request = createGatewayRequestMock().mockRejectedValueOnce(
    new Error("Synthetic retired failure"),
  );
  const ui = mount(connect(request));
  await waitForSolid(() => expect(ui.text()).toContain("Couldn't load automations."));
  const replacementRequest = createGatewayRequestMock().mockResolvedValue(
    jobPage("Current automation", "current"),
  );
  const replacement = connect(replacementRequest);
  ui.setAutomation((previous) => ({ ...previous, gateway: replacement.gateway }));
  await waitForSolid(() => {
    expect(ui.name()?.textContent).toBe("Current automation");
    expect(ui.text()).not.toContain("Couldn't load automations.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(replacementRequest).toHaveBeenCalledTimes(1);
  });
});

it.each(["gateway", "session", "reconnect"] as const)(
  "retires an unresolved read when its %s scope is replaced",
  async (kind) => {
    const retired = Promise.withResolvers<unknown>();
    const request = createGatewayRequestMock()
      .mockImplementationOnce(() => retired.promise)
      .mockResolvedValue(jobPage("Current automation", "current"));
    const source = connect(request);
    const ui = mount(source);
    await waitForSolid(() => expect(request).toHaveBeenCalledTimes(1));
    if (kind === "gateway") {
      const replacement = connect(request);
      ui.setAutomation((previous) => ({ ...previous, gateway: replacement.gateway }));
    } else if (kind === "session") {
      ui.setAutomation((previous) => ({ ...previous, sessionKey: "agent:main:replacement" }));
    } else {
      const connected = source.gateway.snapshot;
      source.publish({ ...connected, phase: "offline", client: null });
      await waitForSolid(() =>
        expect(ui.text()).toContain("Automations unavailable for this session."),
      );
      source.publish(connected);
    }
    await waitForSolid(() => {
      expect(request).toHaveBeenCalledTimes(2);
      expect(ui.name()?.textContent).toBe("Current automation");
    });
    if (kind === "gateway") {
      source.publishEvent({ type: "event", event: "cron", payload: {} });
      expect(request).toHaveBeenCalledTimes(2);
    }
    retired.resolve(jobPage("Retired automation", "retired"));
    await retired.promise;
    await waitForSolid(() => {
      expect(ui.name()?.textContent).toBe("Current automation");
      expect(ui.text()).not.toContain("Retired automation");
    });
    ui.view.unmount();
    source.publishEvent({ type: "event", event: "cron", payload: {} });
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("appends the next owner page without replacing the selected automation", async () => {
  const page = Promise.withResolvers<unknown>();
  const jobs = Array.from({ length: 20 }, (_, index) =>
    createCronJob(`job-${index}`, `Automation ${index + 1}`),
  );
  const request = createGatewayRequestMock()
    .mockResolvedValueOnce(
      cronJobsListResponse(jobs, { limit: 20, total: 21, hasMore: true, nextOffset: 20 }),
    )
    .mockImplementationOnce(() => page.promise);
  const ui = mount(connect(request));
  await waitForSolid(() => expect(ui.name()?.textContent).toBe("Automation 1"));
  const choices = () =>
    ui.view.container.querySelectorAll<HTMLButtonElement>(".session-hovercard__automation-choice");
  choices()[1]!.click();
  await waitForSolid(() => expect(ui.name()?.textContent).toBe("Automation 2"));
  const selected = choices()[1];
  ui.view.container.querySelector<HTMLButtonElement>("button.chip")!.click();
  await waitForSolid(() => {
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("true");
    expect(ui.name()?.textContent).toBe("Automation 2");
  });
  expect(request).toHaveBeenLastCalledWith(
    "cron.list",
    expect.objectContaining({
      offset: 20,
      limit: 20,
      sessionKey: "agent:main:example",
      sessionAgentId: "main",
    }),
  );
  page.resolve(
    cronJobsListResponse([createCronJob("job-20", "Automation 21")], {
      limit: 20,
      offset: 20,
      total: 21,
    }),
  );
  await waitForSolid(() => {
    expect(choices()).toHaveLength(21);
    expect(choices()[1]).toBe(selected);
    expect(ui.name()?.textContent).toBe("Automation 2");
    expect(ui.panel()?.getAttribute("aria-busy")).toBe("false");
    expect(ui.retry()).toBeNull();
  });
});

it("names a scheduled plugin command instead of its reserved placeholder", async () => {
  const placeholder = "[plugin-command-scheduled-turn:v1]";
  const request = createGatewayRequestMock(async () =>
    cronJobsListResponse(
      [
        createCronJob("scheduled-command", "Watch workflow", {
          payload: { kind: "agentTurn", message: placeholder },
          payloadSource: { kind: "pluginCommand", pluginId: "watcher", command: "watch" },
        }),
      ],
      { limit: 20 },
    ),
  );
  const ui = mount(connect(request));
  await waitForSolid(() => {
    expect(ui.name()?.textContent).toBe("Watch workflow");
    expect(ui.text()).toContain("Plugin command: /watch (watcher)");
  });
  expect(ui.text()).not.toContain(placeholder);
});
