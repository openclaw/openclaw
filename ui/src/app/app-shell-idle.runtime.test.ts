// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { committedRouterState } from "./app-host.test-support.ts";
import { connectShellIdle } from "./app-shell-idle.runtime.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { connectNavigationPrefetch } from "./navigation-prefetch.ts";

vi.mock("./control-ui-favicon-status.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-favicon-status.runtime.ts")>()),
  connectControlUiFavicon: () => () => {},
}));
vi.mock("./navigation-prefetch.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./navigation-prefetch.ts")>()),
  connectNavigationPrefetch: vi.fn(() => () => {}),
}));

afterEach(() => vi.restoreAllMocks());

it("waits for a current pane but lets an intentionally hidden conversation stay unloaded", () => {
  const runtime = bootstrapApplication();
  onTestFinished(() => runtime.stop());
  const shell = createShellOwner();
  const panes: HTMLElementTagNameMap["openclaw-chat-pane"][] = [];
  vi.spyOn(shell, "queryRenderedElements").mockImplementation((tag) =>
    tag === "openclaw-chat-pane" ? panes : [],
  );
  vi.spyOn(runtime.context.router, "getState").mockReturnValue(
    committedRouterState("dashboard", "/dashboard"),
  );
  onTestFinished(connectShellIdle(shell, runtime.context, 0));
  const ready = vi.mocked(connectNavigationPrefetch).mock.lastCall?.[0].transcriptsReady;
  if (!ready) {
    throw new Error("Navigation preparation was not connected");
  }
  expect(ready()).toBe(false);

  const pane = document.createElement("openclaw-chat-pane");
  const facts = {
    presented: true,
    visuallyPresented: true,
    conversationPresented: false,
    transcriptReady: false,
    transcriptLoading: false,
    composerReady: false,
  };
  for (const key of Object.keys(facts) as (keyof typeof facts)[]) {
    Object.defineProperty(pane, key, { configurable: true, get: () => facts[key] });
  }
  panes.push(pane);
  expect(ready()).toBe(true);

  facts.conversationPresented = true;
  facts.transcriptLoading = true;
  expect(ready()).toBe(false);
  facts.transcriptLoading = false;
  facts.transcriptReady = true;
  expect(ready()).toBe(false);
  facts.composerReady = true;
  expect(ready()).toBe(true);

  facts.presented = false;
  expect(ready()).toBe(false);
  facts.presented = true;
  facts.visuallyPresented = false;
  expect(ready()).toBe(false);
});

it("waits for mounted plugin activation without waiting for unrelated plugins", () => {
  const runtime = bootstrapApplication();
  onTestFinished(() => runtime.stop());
  const shell = createShellOwner();
  const page = document.createElement("openclaw-plugin-page");
  page.pluginId = "workboard";
  const pages = [page];
  vi.spyOn(shell, "queryRenderedElements").mockImplementation((tag) =>
    tag === "openclaw-plugin-page" ? pages : [],
  );
  vi.spyOn(runtime.context.router, "getState").mockReturnValue(
    committedRouterState("workboard", "/workboard"),
  );
  const loading = new Set(["workboard", "unrelated"]);
  vi.spyOn(runtime.context.plugins, "isLoading").mockImplementation((id) => loading.has(id));
  onTestFinished(connectShellIdle(shell, runtime.context, 0));
  const ready = vi.mocked(connectNavigationPrefetch).mock.lastCall?.[0].transcriptsReady;
  if (!ready) {
    throw new Error("Navigation preparation was not connected");
  }

  expect(ready()).toBe(false);
  loading.delete("workboard");
  expect(ready()).toBe(true);

  page.pluginId = "unrelated";
  expect(ready()).toBe(false);
  pages.length = 0;
  expect(ready()).toBe(true);
});
