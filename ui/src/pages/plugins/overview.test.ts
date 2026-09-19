import { render } from "lit";
import { expect, it } from "vitest";
import { renderPluginMetadata, renderPluginPublisher } from "./overview.ts";
import { createDiscoveryDetail } from "./plugins-page.test-support.ts";
import { renderPluginSecurityAudit } from "./security-audit.ts";

it.each([
  "Martian-Engineering/lossless-claw",
  "git+https://github.com/Martian-Engineering/lossless-claw.git",
])("renders repository identity from %s", (source) => {
  const result = createDiscoveryDetail();
  result.detail.repositoryUrl = source;
  const container = document.createElement("div");
  render(renderPluginMetadata(result), container);
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
  render(renderPluginMetadata(result), container);
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

it("links the publisher handle and only badges authoritative publisher status", () => {
  const result = createDiscoveryDetail();
  result.plugin.catalog.official = true;
  result.detail.author = { handle: "acme", displayName: "Acme" };
  const container = document.createElement("div");
  render(renderPluginPublisher(result), container);
  expect(container.querySelector('a[href="https://clawhub.ai/acme"]')).not.toBeNull();
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector('[aria-label="Official"]')).toBeNull();
  result.detail.author.official = true;
  render(renderPluginPublisher(result), container);
  expect(container.querySelector('[aria-label="Official"]')).not.toBeNull();
});

it.each([
  ["clean", 3],
  ["review", 2],
  ["malicious", 1],
  ["pending", 0],
  ["unknown", 0],
] as const)("shows %s audit with %i bars and the exact ClawHub link", (verdict, count) => {
  const container = document.createElement("div");
  render(
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
