import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { domProbe } from "../../test-helpers/dom-probe.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  renderPluginCatalogDetail as Detail,
  type PluginCatalogDetailProps as Props,
} from "./catalog-detail.tsx";
import {
  renderPluginCompatibilityNotices as compatibilityNotices,
  renderPluginMetadata as metadata,
  renderPluginPublisher as publisher,
} from "./overview.tsx";
import { createDiscoveryDetail, createPlugin } from "./plugins-page.test-support.ts";

afterEach(cleanupSolid);

const detailProps = (result = createDiscoveryDetail(), overrides: Partial<Props> = {}): Props => ({
  connected: true,
  result,
  read: { receipt: () => null, value: () => null },
  backHref: "/plugins",
  onBack: vi.fn(),
  onRetry: vi.fn(),
  canInstall: true,
  installBlockedReason: null,
  onInstall: vi.fn(),
  iconUrls: {},
  ...overrides,
});
function mount(result = createDiscoveryDetail(), overrides: Partial<Props> = {}) {
  return render(() => <Detail {...detailProps(result, overrides)} />);
}

it.each([undefined, "bundle-plugin"] as const)(
  "places qualified installation trust before the actions (family=%s)",
  (family) => {
    const result = createDiscoveryDetail(
      createPlugin({ installed: false, state: "not-installed" }),
    );
    result.plugin.catalog.family = family;
    result.detail.uiCapabilities = ["page"];
    const { container } = mount(result);
    const notice = container.querySelector(".plugin-native-ui-disclosure");
    expect(notice?.textContent).toContain(
      family === "bundle-plugin" ? "Bundles can add content" : "If a plugin includes native web UI",
    );
    expect(notice?.textContent).not.toContain("Includes native web UI");
    const actions = container.querySelector(".plugin-catalog-detail__actions")!;
    expect(notice!.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  },
);

it.each([false, true])(
  "keeps Ask available when installation is blocked (installed=%s)",
  (installed) => {
    const result = createDiscoveryDetail(createPlugin({ installed }));
    const onInstall = vi.fn();
    const onAskPlugin = vi.fn();
    const { query } = mount(result, { canInstall: false, onInstall, onAskPlugin });
    expect(query(".plugin-capabilities")).toBeNull();
    const actions = query(".plugin-catalog-detail__actions")!;
    const primaryButton = actions.querySelector<HTMLButtonElement>("button.primary")!;
    expect(primaryButton.textContent?.trim()).toBe(installed ? "Ask OpenClaw" : "Install");
    expect(actions.querySelectorAll("button.primary")).toHaveLength(1);
    expect(actions.querySelector("button")).toBe(primaryButton);
    primaryButton.click();
    expect(onInstall).not.toHaveBeenCalled();
    const ask = [...actions.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Ask OpenClaw",
    )!;
    ask.click();
    expect(onAskPlugin).toHaveBeenCalledTimes(installed ? 2 : 1);
  },
);

it("renders complete catalog content in capability order", () => {
  const result = createDiscoveryDetail(createPlugin({ origin: "official" }));
  const imageUrl = "https://example.com/icon.png";
  result.plugin.catalog.imageUrl = imageUrl;
  result.detail.contracts = {
    videoGenerationProviders: ["heygen", "heygen-alias"],
    gatewayMethodDispatch: ["internal-dispatch"],
    tools: ["render_status"],
  };
  result.detail.uiCapabilities = ["link-reader", "widget"];
  result.detail.skills = [{ name: "video-guide" }];
  result.detail.mcpServers = ["media-server"];
  const { query, all, container } = mount(result, {
    iconUrls: { [imageUrl]: "blob:package-icon" },
  });
  expect(query(".plugin-catalog-detail__icon .plugins-tile--white")).not.toBeNull();
  expect(query(".plugin-capabilities button")).toBeNull();
  expect([...all(".plugin-capabilities h2")].map((heading) => heading.textContent)).toEqual([
    "Capabilities3",
    "Skills1",
    "Tools1",
    "MCP Server1",
  ]);
  expect(container.textContent).not.toMatch(/internal-dispatch|heygen-alias/);
});

it("retains catalog controls while refreshing the same accepted plugin", async () => {
  const pending = Promise.withResolvers<void>();
  onTestFinished(() => pending.resolve());
  let refresh = () => {};
  const initialResult = createDiscoveryDetail(createPlugin({ installed: false }));
  const onInstall = vi.fn();
  const view = mountSolid(() => {
    const [result, setResult] = createSignal(initialResult);
    const [receipt, setReceipt] = createSignal({ result: Promise.resolve() });
    const value = createMemo(async () => {
      await receipt().result;
      return null;
    });
    refresh = () => {
      setResult({ ...initialResult });
      setReceipt({ result: pending.promise });
    };
    return <Detail {...detailProps(result(), { read: { receipt, value }, onInstall })} />;
  });
  await waitForSolid(() => expect(view.container.querySelector("button.primary")).not.toBeNull());
  const button = view.container.querySelector<HTMLButtonElement>("button.primary")!;
  refresh();
  flush();
  expect(view.container.querySelector(".plugin-catalog-detail--loading")).toBeNull();
  expect(view.container.querySelector("button.primary")).toBe(button);
  button.click();
  expect(onInstall).toHaveBeenCalledOnce();
});
const views = new WeakMap<Element, { unmount: () => void }>();
function render(content: () => JSX.Element, container = document.createElement("div")) {
  views.get(container)?.unmount();
  const view = mountSolid(content, { container });
  views.set(container, view);
  flush();
  return { container, ...domProbe(container) };
}
const notice = {
  code: "deprecated-sdk-api" as const,
  severity: "info" as const,
  message:
    "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update.",
  removalDate: "2026-12-31",
  migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration",
  apis: [],
};
function renderNotice(overrides: Partial<typeof notice> = {}) {
  return render(() => compatibilityNotices([{ ...notice, ...overrides }]));
}

it("localizes a mounted compatibility notice from its structured removal date", async () => {
  onTestFinished(captureI18nStateForTesting());
  const translate = i18n.t.bind(i18n);
  const translation = vi.spyOn(i18n, "t").mockImplementation((key, params) => {
    if (i18n.getLocale() === "de") {
      if (key === "pluginsPage.compatibilityDeprecatedDated") {
        return `Verwendet OpenClaw-APIs bis ${params?.date}.`;
      }
      if (key === "pluginsPage.compatibilityDetails") {
        return "Mehr erfahren";
      }
    }
    return translate(key, params);
  });
  onTestFinished(() => translation.mockRestore());
  await i18n.setLocale("en");
  const { container } = renderNotice({ message: "Server-only English fallback" });
  expect(container.textContent).toBe(
    "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update. Details",
  );
  await i18n.setLocale("de");
  flush();
  expect(container.textContent).toBe("Verwendet OpenClaw-APIs bis 31. Dez. 2026. Mehr erfahren");
});

it("uses catalog copy when a compatibility notice has no removal date", () => {
  const { container } = renderNotice({
    message: "Server-only English fallback",
    removalDate: undefined,
  });
  expect(container.textContent).toBe(
    "Uses older OpenClaw APIs. It keeps working for now; check for a plugin update. Details",
  );
});

it("normalizes shorthand repositories and keeps documentation separate", () => {
  const result = createDiscoveryDetail();
  const repository = "https://github.com/Acme/plugin";
  const documentation = `${repository}/blob/main/docs/setup.md`;
  result.detail.repositoryUrl = "Acme/plugin";
  result.detail.documentationUrl = documentation;
  const { container, all, query, attr, text } = render(() => metadata(result));
  expect(attr(".plugin-metadata__repository", "href")).toBe(repository);
  expect(text(".plugin-metadata__repository")).toContain("Acme/plugin");
  expect([...all("section")].map((section) => section.querySelector("h2")?.textContent)).toEqual([
    "Repository",
    "Documentation",
  ]);
  expect(container.textContent).not.toContain("View on ClawHub");
  expect(query(`a[href="${documentation}"]`)).not.toBeNull();
});

it("omits absent publishers and only badges authoritative publisher status", () => {
  const result = createDiscoveryDetail();
  result.plugin.catalog.official = true;
  result.detail.author = { handle: "acme", displayName: "Acme" };
  const { container, query, text } = render(() => publisher(undefined));
  expect(container.children).toHaveLength(0);
  render(() => publisher(undefined, "Local publisher"), container);
  expect(text("strong")).toBe("Local publisher");
  render(() => publisher(result), container);
  expect(query('a[href="https://clawhub.ai/acme"]')).not.toBeNull();
  expect(query('[aria-label="Official"]')).toBeNull();
  result.detail.author.official = true;
  render(() => publisher(result), container);
  expect(query('[aria-label="Official"]')).not.toBeNull();
});

it.each([
  ["clean", 3],
  ["review", 2],
  ["malicious", 1],
  ["unknown", 0],
] as const)("shows %s audit with %i bars and the exact ClawHub link", (verdict, count) => {
  const url = "https://clawhub.ai/acme/plugins/demo/security-audit?version=1.0";
  const result = createDiscoveryDetail();
  result.detail.security = { status: verdict, verdict, auditUrl: url };
  const { all, attr } = render(() => metadata(result));
  expect(all(".is-filled")).toHaveLength(count);
  expect(attr("a", "href")).toBe(url);
});
