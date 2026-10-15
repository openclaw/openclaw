import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { captureI18nStateForTesting } from "../../i18n/lib/translate.test-support.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { mountSolid, cleanupSolid } from "../../test-helpers/mount-solid.ts";
import {
  renderPluginCompatibilityNotices,
  renderPluginMetadata,
  renderPluginPublisher,
} from "./overview.tsx";
import { createDiscoveryDetail } from "./plugins-page.test-support.ts";
import { renderPluginSecurityAudit } from "./security-audit.tsx";

const views = new WeakMap<Element, { unmount: () => void }>();
function render(content: () => JSX.Element, container: HTMLDivElement) {
  views.get(container)?.unmount();
  const view = mountSolid(content, { container });
  views.set(container, view);
  flush();
}
afterEach(cleanupSolid);

it("omits compatibility notices for plugins without observed deprecated API usage", () => {
  const container = document.createElement("div");
  render(() => renderPluginCompatibilityNotices(undefined), container);
  expect(container.children).toHaveLength(0);
});

it("shows neutral compatibility copy and adds API replacements only in plugin details", () => {
  const notice = {
    code: "deprecated-sdk-api" as const,
    severity: "info" as const,
    message:
      "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update.",
    removalDate: "2026-12-31",
    migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration",
    apis: [
      {
        id: "channel-pairing-sync-allowlist",
        displayName: "readChannelAllowFromStoreSync",
        replacement: "Await readChannelAllowFromStore instead.",
      },
    ],
  };
  const notices = [notice];
  const container = document.createElement("div");
  render(() => renderPluginCompatibilityNotices(notices), container);
  const message = container.querySelector(".plugins-row-message--info");
  expect(message?.textContent).toContain(notice.message);
  expect(message?.getAttribute("role")).toBe("status");
  expect(
    container.querySelector(".oc-banner-warning, .oc-banner-error, svg, [role=alert]"),
  ).toBeNull();
  expect(container.querySelector("a")?.textContent).toBe("Details");
  expect(container.querySelector("a")?.getAttribute("href")).toBe(notice.migrationGuideUrl);
  expect(container.textContent).not.toContain("readChannelAllowFromStoreSync");
  render(() => renderPluginCompatibilityNotices(notices, true), container);
  expect(container.querySelector("dt")?.textContent).toBe("readChannelAllowFromStoreSync");
  expect(container.querySelector("dd")?.textContent).toBe(
    "Await readChannelAllowFromStore instead.",
  );
});

it("localizes a mounted compatibility notice from its structured removal date", async () => {
  onTestFinished(captureI18nStateForTesting());
  const translate = i18n.t.bind(i18n);
  const translation = vi
    .spyOn(i18n, "t")
    .mockImplementation((key, params) =>
      key === "pluginsPage.compatibilityDeprecatedDated" && i18n.getLocale() === "de"
        ? `Verwendet OpenClaw-APIs bis ${params?.date}.`
        : translate(key, params),
    );
  onTestFinished(() => translation.mockRestore());
  await i18n.setLocale("en");
  const container = document.createElement("div");
  render(
    () =>
      renderPluginCompatibilityNotices([
        {
          code: "deprecated-sdk-api",
          severity: "info",
          message: "Server-only English fallback",
          removalDate: "2026-12-31",
          migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration",
          apis: [],
        },
      ]),
    container,
  );
  expect(container.textContent).toBe(
    "Uses OpenClaw APIs that retire on Dec 31, 2026. It keeps working until then; check for a plugin update. Details",
  );
  await i18n.setLocale("de");
  flush();
  expect(container.textContent).toBe("Verwendet OpenClaw-APIs bis 31. Dez. 2026. Details");
});

it("uses catalog copy when a compatibility notice has no removal date", () => {
  const container = document.createElement("div");
  render(
    () =>
      renderPluginCompatibilityNotices([
        {
          code: "deprecated-sdk-api",
          severity: "info",
          message: "Server-only English fallback",
          migrationGuideUrl: "https://docs.openclaw.ai/plugins/sdk-migration",
          apis: [],
        },
      ]),
    container,
  );
  expect(container.textContent).toBe(
    "Uses older OpenClaw APIs. It keeps working for now; check for a plugin update. Details",
  );
});

it.each([
  "Martian-Engineering/lossless-claw",
  "git+https://github.com/Martian-Engineering/lossless-claw.git",
])("renders repository identity from %s", (source) => {
  const result = createDiscoveryDetail();
  result.detail.repositoryUrl = source;
  const container = document.createElement("div");
  render(() => renderPluginMetadata(result), container);
  const link = container.querySelector(".plugin-metadata__repository");
  expect(link?.getAttribute("href")).toBe("https://github.com/Martian-Engineering/lossless-claw");
  expect(link?.textContent).toContain("Martian-Engineering/lossless-claw");
  expect(link?.querySelector("svg")).not.toBeNull();
});

it("keeps documentation distinct and removes the catalog promotion sections", () => {
  const result = createDiscoveryDetail();
  result.detail.repositoryUrl = "https://github.com/Acme/plugin";
  result.detail.documentationUrl = "https://github.com/Acme/plugin/blob/main/docs/setup.md";
  const container = document.createElement("div");
  render(() => renderPluginMetadata(result), container);
  expect(
    [...container.querySelectorAll("section")].map(
      (section) => section.querySelector("h2")?.textContent,
    ),
  ).toEqual(["Repository", "Documentation"]);
  expect(container.querySelector(".plugin-metadata__repository")?.textContent).toContain(
    "Acme/plugin",
  );
  expect(container.textContent).not.toContain("View on ClawHub");
  expect(
    container.querySelector('a[href="https://github.com/Acme/plugin/blob/main/docs/setup.md"]'),
  ).not.toBeNull();
});

it("omits absent publishers and only badges authoritative publisher status", () => {
  const result = createDiscoveryDetail();
  result.plugin.catalog.official = true;
  result.detail.author = { handle: "acme", displayName: "Acme" };
  const container = document.createElement("div");
  render(() => renderPluginPublisher(undefined), container);
  expect(container.children).toHaveLength(0);
  render(() => renderPluginPublisher(undefined, "Local publisher"), container);
  expect(container.querySelector("strong")?.textContent).toBe("Local publisher");
  render(() => renderPluginPublisher(result), container);
  expect(container.querySelector('a[href="https://clawhub.ai/acme"]')).not.toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('[aria-label="Official"]')).toBeNull();
  result.detail.author.official = true;
  render(() => renderPluginPublisher(result), container);
  expect(container.querySelector('[aria-label="Official"]')).not.toBeNull();
});

it.each([
  ["clean", 3],
  ["review", 2],
  ["malicious", 1],
  ["unknown", 0],
] as const)("shows %s audit with %i bars and the exact ClawHub link", (verdict, count) => {
  const container = document.createElement("div");
  render(
    () =>
      renderPluginSecurityAudit(
        verdict,
        "https://clawhub.ai/acme/plugins/demo/security-audit?version=1.0",
      ),
    container,
  );
  expect(container.querySelectorAll(".is-filled")).toHaveLength(count);
  expect(container.querySelector("a")?.getAttribute("href")).toBe(
    "https://clawhub.ai/acme/plugins/demo/security-audit?version=1.0",
  );
});
