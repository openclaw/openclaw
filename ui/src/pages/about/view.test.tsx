/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { AboutView } from "./view.tsx";

type AboutProps = Parameters<typeof AboutView>[0];

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_AT = "2026-07-10T11:22:33.000Z";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

function expectAttributes(element: Element | null | undefined, attributes: Record<string, string>) {
  for (const [name, value] of Object.entries(attributes)) {
    expect(element?.getAttribute(name)).toBe(value);
  }
}

function formatDate(locale: string, date: string, options: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", ...options }).format(
    new Date(date),
  );
}

function render(
  overrides: Partial<AboutProps> = {},
  buildInfo: Partial<AboutProps["buildInfo"]> = {},
) {
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
      ...buildInfo,
    },
    gatewayVersion: "2026.7.9",
    copyState: "idle",
    onCopyCommit: vi.fn(),
    clawdWaving: false,
    onPokeClawd: vi.fn(),
    ...overrides,
  };
  let setProps!: (props: AboutProps) => void;
  const { container } = mountSolid(
    () => {
      const [state, setState] = createSignal(props);
      setProps = setState;
      return <AboutView {...state()} />;
    },
    { container: document.createElement("div") },
  );
  flush();
  return {
    container,
    query: container.querySelector.bind(container),
    props,
    update(next: Partial<AboutProps>) {
      setProps({ ...props, ...next });
      flush();
    },
  };
}

beforeEach(() => i18n.setLocale("en"));

it("renders the hero with Clawd, identity, community links, and license", () => {
  const { query, props } = render();

  const hero = query(".about-hero");
  expect(hero?.querySelector(".about-hero__name")?.textContent).toBe("OpenClaw");
  expect(hero?.querySelector(".about-hero__version")?.textContent).toBe("v2026.7.10");
  expect(hero?.querySelector(".about-hero__clawd svg")).not.toBeNull();

  const clawd = hero?.querySelector<HTMLButtonElement>(".about-hero__clawd");
  expect(clawd?.getAttribute("aria-label")).toBe("Wave hello to Clawd");
  clawd?.click();
  expect(props.onPokeClawd).toHaveBeenCalledOnce();

  const links = Array.from(hero?.querySelectorAll<HTMLAnchorElement>(".about-hero__link") ?? []);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://openclaw.ai",
    "https://docs.openclaw.ai",
    "https://github.com/openclaw/openclaw",
    "https://discord.gg/clawd",
    "https://x.com/openclaw",
    "https://docs.openclaw.ai/releases",
  ]);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  }

  expect(query(".about-footer")?.textContent).toContain("MIT License");
});

it("marks the hero as waving only while a poke is active", () => {
  const { query, update } = render({ clawdWaving: true });
  expect(query(".about-hero__clawd--wave")).not.toBeNull();

  update({ clawdWaving: false });
  expect(query(".about-hero__clawd--wave")).toBeNull();
});

it("keeps version, commit, branch, and localized UTC build date in one facts grid", async () => {
  const { query } = render();

  const facts = query(".settings-kv");
  const values = facts?.querySelectorAll("dd");
  expect(facts?.tagName).toBe("DL");
  expect(facts?.hasAttribute("role")).toBe(false);
  expect(facts?.getAttribute("aria-label")).toBe("Control UI build details");
  expect(facts?.classList.contains("about-build-grid")).toBe(true);
  expect(values).toHaveLength(4);
  expect(values?.[0]?.textContent).toContain("2026.7.10");
  const code = values?.[1]?.querySelector("code");
  expect(code?.textContent).toBe(COMMIT.slice(0, 12));
  expectAttributes(code, { title: COMMIT, dir: "ltr" });

  const commitAge = values?.[1]?.querySelector("time.about-commit__age");
  expectAttributes(commitAge, {
    datetime: COMMIT_AT,
    title: formatDate("en", COMMIT_AT, { timeStyle: "short" }),
  });
  expect(commitAge?.textContent?.trim()).not.toBe("");
  expect(commitAge?.nextElementSibling?.tagName.toLowerCase()).toBe("openclaw-tooltip");

  expect(values?.[2]?.textContent).toContain("feature/build-chip*");

  const time = values?.[3]?.querySelector("time");
  expectAttributes(time, { datetime: BUILT_AT, title: BUILT_AT, dir: "auto" });
  expect(time?.textContent).toBe(formatDate("en", BUILT_AT, { timeZone: "UTC" }));

  await i18n.setLocale("de");
  flush();
  expect(time?.textContent).toBe(formatDate("de", BUILT_AT, { timeZone: "UTC" }));
  expect(commitAge?.getAttribute("title")).toBe(
    formatDate("de", COMMIT_AT, { timeStyle: "short" }),
  );
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
    {
      version: null,
      commit: null,
      commitAt: null,
      builtAt: null,
      branch: null,
      dirty: null,
      release: false,
      buildId: "dev",
    },
  );

  expect(container.querySelectorAll(".settings-kv .muted")).toHaveLength(3);
  expect(query(".settings-row__value")?.textContent).toContain("Unavailable");
  expect(query(".about-commit button")).toBeNull();
  expect(container.textContent).not.toContain("Unknown build");
});
