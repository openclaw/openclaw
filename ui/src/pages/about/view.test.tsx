/* @vitest-environment jsdom */

import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";
import { AboutView } from "./view.tsx";

type AboutProps = Parameters<typeof AboutView>[0];

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_AT = "2026-07-10T11:22:33.000Z";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

function render(overrides: Partial<AboutProps> = {}, build: Partial<AboutProps["buildInfo"]> = {}) {
  const props: AboutProps = {
    buildInfo: {
      version: "2026.7.10",
      commit: COMMIT,
      commitAt: COMMIT_AT,
      builtAt: BUILT_AT,
      branch: "feature/build-chip",
      dirty: true,
      release: false,
      buildId: "test",
      ...build,
    },
    gatewayVersion: "2026.7.9",
    copyState: "idle",
    onCopyCommit: vi.fn(),
    clawdWaving: false,
    onPokeClawd: vi.fn(),
    ...overrides,
  };
  const view = mountSolid(AboutView, props);
  return {
    ...view,
    query: view.container.querySelector.bind(view.container),
    props,
    update: (next: AboutProps) => view.update(next),
  };
}

beforeEach(() => i18n.setLocale("en"));

it("renders the hero, links, license, and Clawd's active wave", () => {
  const { query, props, update } = render({ clawdWaving: true });
  expect(query(".about-hero .about-hero__name")?.textContent).toBe("OpenClaw");
  expect(query(".about-hero .about-hero__version")?.textContent).toBe("v2026.7.10");
  expect(query(".about-hero .about-hero__clawd svg")).not.toBeNull();

  const clawd = query<HTMLButtonElement>(".about-hero .about-hero__clawd");
  expect(clawd?.getAttribute("aria-label")).toBe("Wave hello to Clawd");
  clawd?.click();
  expect(props.onPokeClawd).toHaveBeenCalledOnce();
  expect(query(".about-hero__clawd--wave")).not.toBeNull();
  update({ ...props, clawdWaving: false });
  expect(query(".about-hero__clawd--wave")).toBeNull();

  const links = Array.from(query(".about-hero")?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  expect(links.find((link) => link.textContent?.trim() === "Support")?.href).toBe(
    "https://community.openclaw.ai/",
  );
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  }
  expect(query(".about-footer")?.textContent).toContain("MIT License");
});

it("keeps version, commit, branch, and localized UTC build date in one facts grid", async () => {
  const { query } = render();
  const facts = query(".settings-kv");
  const values = facts?.querySelectorAll("dd");
  expect(facts).toMatchObject({ tagName: "DL", ariaLabel: "Control UI build details" });
  expect(facts?.hasAttribute("role")).toBe(false);
  expect(facts?.classList.contains("about-build-grid")).toBe(true);
  expect(values).toHaveLength(4);
  expect(values?.[0]?.textContent).toContain("2026.7.10");
  expect(values?.[1]?.querySelector("code")).toMatchObject({
    textContent: COMMIT.slice(0, 12),
    title: COMMIT,
    dir: "ltr",
  });
  const commitAge = values?.[1]?.querySelector("time.about-commit__age");
  expect(commitAge).toMatchObject({
    dateTime: COMMIT_AT,
    nextElementSibling: { tagName: "OPENCLAW-TOOLTIP" },
  });
  expect(commitAge?.textContent?.trim()).not.toBe("");
  expect(values?.[2]?.textContent).toContain("feature/build-chip*");
  const time = values?.[3]?.querySelector("time");
  expect(time).toMatchObject({ dateTime: BUILT_AT, title: BUILT_AT, dir: "auto" });
  for (const locale of ["en", "de"] as const) {
    await i18n.setLocale(locale);
    flush();
    const day = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    expect(time?.textContent).toBe(day.format(new Date(BUILT_AT)));
    expect(commitAge?.getAttribute("title")).toBe(
      new Date(COMMIT_AT).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }),
    );
  }
});

it("keeps the commit hash without an age when no commit timestamp is embedded", () => {
  const { query } = render({}, { commitAt: null });
  expect(query(".about-commit code")?.textContent).toBe(COMMIT.slice(0, 12));
  expect(query(".about-commit__age")).toBeNull();
});

it("copies the full commit while announcing success accessibly", () => {
  const { query, props } = render({ copyState: "copied" });
  const button = query<HTMLButtonElement>(".about-commit button");
  expect(button?.getAttribute("aria-label")).toBe("Commit hash copied");
  expect(query("[role='status']")?.textContent?.trim()).toBe("Commit hash copied");
  button?.click();
  expect(props.onCopyCommit).toHaveBeenCalledOnce();
});

it("states when artifact identity and Gateway version are unavailable", () => {
  const { container, query } = render(
    { gatewayVersion: null },
    { version: null, commit: null, commitAt: null, builtAt: null, branch: null },
  );
  expect(container.querySelectorAll(".settings-kv .muted")).toHaveLength(3);
  expect(query(".settings-row__value")?.textContent).toContain("Unavailable");
  expect(query(".about-commit button")).toBeNull();
  expect(container.textContent).not.toContain("Unknown build");
});
