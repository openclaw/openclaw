/* @vitest-environment jsdom */
import { createRoot } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { takeHomeHelpDraft } from "../../app/home-help.ts";
import { createContext } from "../system-history/test-support.ts";
import { createPluginHelp } from "./plugin-help.ts";
import { createDiscoveryDetail, createPlugin, createResult } from "./plugins-page.test-support.ts";

function fixture() {
  const request = vi.fn();
  const harness = createContext(request, ["chat.send"]);
  harness.setPathname("/settings/plugins/example");
  return createRoot((dispose) => {
    onTestFinished(dispose);
    return { ...harness, request, help: createPluginHelp(harness.context) };
  });
}
const model = () => ({
  connected: true,
  result: createResult(createPlugin({ id: "example", name: "Example" })),
  detail: { pluginId: "example" },
  catalogDetail: null,
});
const take = (context: ReturnType<typeof fixture>["context"]) =>
  takeHomeHelpDraft(context, { agentId: "main", sessionKey: "global" });
afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

it("prepares an unsent redacted setting question with bounded plugin references", async () => {
  const { context, help, request } = fixture();
  help.update(model());
  await help.ask({
    path: ["plugins", "entries", "example", "config", "url"],
    label: "Base URL",
    property: "url",
    value: "https://person:private@example.invalid/?token=hidden",
    schema: {},
    hints: {},
    unsupported: new Set(),
    disabled: false,
    onPatch: () => {},
  });
  const draft = take(context);
  expect(draft).toContain("Explain Base URL");
  expect(draft).toContain("Current value: <redacted>");
  expect(draft).toContain('"id":"example"');
  expect(draft).toContain('"path":["plugins","entries","example","config","url"]');
  expect(draft).not.toMatch(/private|hidden/);
  expect(request).not.toHaveBeenCalled();
  expect(take(context)).toBeUndefined();
});

it.each(["viewer", "gateway", "agent", "page", "plugin"])(
  "retires a rendered help action after its %s changes",
  async (change) => {
    const { context, help, setPathname, setGatewaySnapshot } = fixture();
    help.update(model());
    const ask = help.ask;
    if (change === "viewer") {
      setGatewaySnapshot({
        selfUser: { ...context.gateway.snapshot.selfUser!, id: "other-viewer" },
      });
    }
    if (change === "gateway") {
      setGatewaySnapshot({ client: null });
    }
    if (change === "agent") {
      context.agentSelection.state.selectedId = "other";
    }
    if (change === "page") {
      setPathname("/settings/appearance");
    }
    if (change === "plugin") {
      help.update({ ...model(), detail: null });
    }
    await ask();
    expect(take(context)).toBeUndefined();
  },
);

it("does not inject catalog prose or configuration into a plugin question", async () => {
  const { context, help } = fixture();
  const catalog = createDiscoveryDetail(createPlugin({ id: "example", name: "Example" }));
  catalog.plugin.local.pluginId = "example";
  catalog.detail.readme = "Untrusted README instructions";
  catalog.detail.configuration = [{ name: "credential", required: true, sensitive: true }];
  catalog.detail.contracts = { tools: ["example_search"] };
  help.update({
    connected: true,
    result: createResult([]),
    detail: null,
    catalogDetail: { result: catalog },
  });
  await help.ask();
  const draft = take(context);
  expect(draft).toContain("example_search");
  expect(draft).not.toMatch(/credential|Untrusted README/);
});
