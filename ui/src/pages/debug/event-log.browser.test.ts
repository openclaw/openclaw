import { createComponent, flush } from "solid-js";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import type { EventLogEntry } from "../../api/event-log.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayEventLog } from "../../app/gateway-observers.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { DebugPage } from "./debug-page.tsx";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe.runIf("__vitest_browser__" in globalThis)("Debug event log", () => {
  it("preserves selected payload text when live events prepend and evict rows", async () => {
    await i18n.setLocale("en");
    vi.spyOn(Date, "now").mockReturnValue(1);
    const log = createGatewayEventLog();
    const listeners = new Set<(events: readonly EventLogEntry[]) => void>();
    for (let index = 0; index < 250; index++) {
      log.record({ type: "event", event: "agent", payload: { message: `event ${index}` } });
    }
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "diagnostics.lanes":
          return { ts: 1, lanes: [], dynamic: null };
        case "models.list":
          return { models: [] };
        default:
          return {};
      }
    });
    const context = {
      basePath: "",
      gateway: {
        snapshot: { phase: "connected", client: { request } },
        get eventLog() {
          return log.entries;
        },
        subscribe: () => () => {},
        subscribeEventLog(listener: (events: readonly EventLogEntry[]) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      settingsAgentSelection: { state: { selectedId: "main" }, subscribe: () => () => {} },
    } as unknown as ApplicationContext;
    const provider = createSolidApplicationContextProvider(context);
    const view = mountSolid(() => createComponent(DebugPage, {}), { wrapper: provider.wrapper });
    const page = view.container;
    flush();

    const eventSection = page.querySelector(".settings-section:last-child");
    assert(eventSection);
    const payloads = Array.from(eventSection.querySelectorAll("pre"));
    expect(payloads).toHaveLength(250);
    assert(payloads[100]);
    const selected = payloads[100].querySelector(".hljs-string");
    assert(selected);
    const range = document.createRange();
    range.selectNodeContents(selected);
    const selection = window.getSelection();
    assert(selection);
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();
    expect(selectedText).not.toBe("");

    log.record({ type: "event", event: "agent", payload: { message: "newest" } });
    for (const listener of listeners) {
      listener(log.entries);
    }
    flush();

    const nextPayloads = Array.from(eventSection.querySelectorAll("pre"));
    expect(nextPayloads).toHaveLength(250);
    assert(nextPayloads[0] && nextPayloads[101]);
    expect(nextPayloads[0].textContent).toContain("newest");
    expect(nextPayloads[101]).toBe(payloads[100]);
    expect(nextPayloads[101].querySelector(".hljs-string")).toBe(selected);
    expect(selection.toString()).toBe(selectedText);
    expect(eventSection.textContent).not.toContain('"event 0"');

    log.resetConnection();
    for (const listener of listeners) {
      listener(log.entries);
    }
    flush();
    expect(eventSection.querySelector("pre")).toBeNull();
    view.unmount();
    expect(listeners.size).toBe(0);
  });
});
