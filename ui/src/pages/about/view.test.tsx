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
    gateway: { version: "2026.7.9", commit: "abcdef0", builtAt: "2026-07-09T08:07:00.000Z" },
    clawdWaving: false,
    onPokeClawd: vi.fn(),
    ...overrides,
  };
  let setProps!: (props: AboutProps) => void;
  const { container } = mountSolid(() => {
    const [state, setState] = createSignal(props);
    setProps = setState;
    return <AboutView {...state()} />;
  });
  flush();
  return {
    container,
    query: container.querySelector.bind(container),
    props,
    update: setProps,
  };
}

beforeEach(() => i18n.setLocale("en"));

it("renders the hero, links, license, and Clawd's active wave", () => {
  const { query, props, update } = render({ clawdWaving: true });
  const hero = query(".about-hero");
  expect(hero?.querySelector(".about-hero__name")?.textContent).toBe("OpenClaw");
  expect(hero?.querySelector(".about-hero__version")?.textContent).toBe("v2026.7.10");
  expect(hero?.querySelector(".about-hero__clawd svg")).not.toBeNull();

  const clawd = hero?.querySelector<HTMLButtonElement>(".about-hero__clawd");
  expect(clawd?.getAttribute("aria-label")).toBe("Wave hello to Clawd");
  clawd?.click();
  expect(props.onPokeClawd).toHaveBeenCalledOnce();
  expect(query(".about-hero__clawd--wave")).not.toBeNull();
  update({ ...props, clawdWaving: false });
  flush();
  expect(query(".about-hero__clawd--wave")).toBeNull();

  const links = Array.from(hero?.querySelectorAll<HTMLAnchorElement>(".about-hero__link") ?? []);
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "https://community.openclaw.ai/",
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

function facts(container: HTMLElement, label: string) {
  const list = container.querySelector(`dl.settings-kv[aria-label="${label}"]`);
  const rows = new Map<string, Element>();
  for (const term of Array.from(list?.querySelectorAll("dt") ?? [])) {
    rows.set(term.textContent ?? "", term.nextElementSibling!);
  }
  return { list, rows };
}

it("shows Control UI and Gateway build identity with the shared settings facts", async () => {
  const { container } = render();
  const headings = Array.from(container.querySelectorAll(".settings-section__heading"));
  expect(headings.map((heading) => heading.textContent)).toEqual(["Control UI", "Gateway"]);
  const ui = facts(container, "Control UI build details");
  const gateway = facts(container, "Gateway");
  expect([...ui.rows.keys()]).toEqual(["Version", "Commit", "Branch", "Built"]);
  expect([...gateway.rows.keys()]).toEqual(["Version", "Commit", "Built"]);
  expect(ui.rows.get("Version")?.textContent).toBe("2026.7.10");
  expect(ui.rows.get("Commit")?.querySelector("code")).toMatchObject({
    textContent: COMMIT.slice(0, 7),
    title: COMMIT,
    dir: "ltr",
  });
  expect(ui.rows.get("Branch")?.textContent).toBe("feature/build-chip*");
  expect(gateway.rows.get("Version")?.textContent).toBe("2026.7.9");
  expect(gateway.rows.get("Commit")?.querySelector("code")?.textContent).toBe("abcdef0");
  for (const list of [ui, gateway]) {
    expect(
      list.rows.get("Commit")?.querySelector("button.chat-copy-btn")?.getAttribute("aria-label"),
    ).toBe("Copy full commit hash");
  }
  const time = ui.rows.get("Built")?.querySelector("time");
  expect(time).toMatchObject({ dateTime: BUILT_AT, title: BUILT_AT, dir: "auto" });
  for (const locale of ["en", "de"] as const) {
    await i18n.setLocale(locale);
    flush();
    const stamp = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
    expect(time?.textContent).toBe(stamp.format(new Date(BUILT_AT)));
  }
  expect(container.querySelector(".settings-section__desc")).toBeNull();
});

it("omits unknown facts and marks a disconnected Gateway unavailable", () => {
  const { container } = render(
    { gateway: { version: null, commit: null, builtAt: null } },
    { commit: null, builtAt: null, branch: null },
  );
  const ui = facts(container, "Control UI build details");
  const gateway = facts(container, "Gateway");
  expect([...ui.rows.keys()]).toEqual(["Version"]);
  expect(ui.rows.get("Version")?.textContent).toBe("2026.7.10");
  expect([...gateway.rows.keys()]).toEqual(["Version"]);
  expect(gateway.rows.get("Version")?.textContent).toBe("Unavailable");
  expect(container.querySelector(".chat-copy-btn")).toBeNull();
});
