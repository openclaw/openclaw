import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillsLibraryListResult } from "../../../../../packages/gateway-protocol/src/index.ts";
import { t } from "../../../i18n/index.ts";
import { buildSkillLibraryMock } from "../../../test-helpers/skill-library-fixtures.ts";
import type { ComposerLibraryProps } from "../composer-library-session.ts";
import {
  renderChatComposerPlusMenu,
  type ChatComposerCapabilityMenuProps,
  type ChatComposerPlusMenuView,
} from "./chat-composer-plus-menu.ts";

const [alice, bob] = buildSkillLibraryMock();
const ordinary = { key: "weather", name: "weather", enabled: true, baseEnabled: true };
function library(overrides: Partial<ComposerLibraryProps> = {}): ComposerLibraryProps {
  const result: SkillsLibraryListResult = {
    entries: [],
    profileId: "profile-bob",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 64,
    session: { sessionKey: "agent:main:review", selections: [], attachable: [] },
  };
  return {
    result,
    loading: false,
    busy: false,
    error: null,
    canWrite: true,
    onReload: vi.fn(),
    onRead: vi.fn(),
    onActivate: vi.fn(),
    ...overrides,
  };
}
function withPin(options: { accessible?: boolean; updated?: boolean; canWrite?: boolean } = {}) {
  const state = library({ canWrite: options.canWrite ?? true });
  state.result = {
    ...state.result!,
    entries: options.accessible
      ? [{ ...alice.entry, revision: options.updated ? "2".repeat(64) : alice.entry.revision }]
      : [],
    session: {
      sessionKey: "agent:main:review",
      selections: [alice.entry],
      attachable: [bob.entry],
    },
  };
  return state;
}
function mount(
  overrides: Partial<ChatComposerCapabilityMenuProps> = {},
  view: ChatComposerPlusMenuView = "skills",
) {
  const host = document.body.appendChild(document.createElement("div"));
  const changeView = vi.fn();
  const patch = vi.fn();
  const props: ChatComposerCapabilityMenuProps = {
    basePath: "",
    skills: [],
    skillsLoading: false,
    skillsError: false,
    library: library(),
    mcpServers: [],
    toolsEffectiveResult: null,
    toolsEffectiveLoading: false,
    toolsEffectiveError: false,
    toolAccessMutationBlockedReason: null,
    webSearchBaseEnabled: true,
    mutationBlockedReason: null,
    canAdmin: false,
    adminBlockedReason: null,
    onLoadSkills: vi.fn(),
    onPatchToolOverrides: patch,
    onNavigate: vi.fn(),
    ...overrides,
  };
  render(
    renderChatComposerPlusMenu({
      attachments: {},
      capabilityMenu: props,
      disabled: false,
      open: false,
      view,
      toolOverrides: null,
      onOpenChange: vi.fn(),
      onViewChange: changeView,
    }),
    host,
  );
  const select = (value: string) =>
    host.querySelector("wa-dropdown")!.dispatchEvent(
      new CustomEvent("wa-select", {
        detail: { item: { value } },
        bubbles: true,
        cancelable: true,
      }),
    );
  return {
    host,
    select,
    changeView,
    patch,
    item: (value: string) => host.querySelector('wa-dropdown-item[value="' + value + '"]'),
  };
}
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("composer skills presentation", () => {
  it.each(["personal", "workspace", "unavailable"] as const)(
    "keeps an empty %s library out of an ordinary skill list",
    (target) => {
      const state = library();
      state.result = { ...state.result!, defaultTarget: target };
      const { host, item } = mount({ skills: [ordinary], library: state });
      expect(item("skill:0")).not.toBeNull();
      expect(item("manage-skills")).not.toBeNull();
      expect(item("library-add")).toBeNull();
      expect(host.textContent).not.toMatch(
        /New sessions select|No managed skills|Selected for this session|Agent & workspace/,
      );
      expect(host.textContent).not.toContain(t("chat.composer.menu.noSkills"));
    },
  );

  it("has one empty state only after both catalogs finish", () => {
    const { host } = mount();
    expect(host.textContent?.split(t("chat.composer.menu.noSkills"))).toHaveLength(2);
    expect(host.textContent).not.toContain("No managed skills");
  });

  it.each([
    {
      name: "both loading",
      skills: null,
      skillsLoading: true,
      library: library({ result: null, loading: true }),
    },
    {
      name: "library loading",
      skills: [ordinary],
      skillsLoading: false,
      library: library({ result: null, loading: true }),
    },
    {
      name: "ordinary loading with a private pin",
      skills: null,
      skillsLoading: true,
      library: withPin(),
    },
  ])("does not misreport $name as empty", ({ name: _name, ...props }) => {
    const { host } = mount(props);
    expect(host.textContent).not.toContain(t("chat.composer.menu.noSkills"));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent?.trim()).toBe("");
    expect(host.querySelectorAll(".skeleton")).toHaveLength(2);
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      t("common.loading"),
    );
    if (props.skills?.length) {
      expect(host.textContent).toContain("weather");
    }
    if (props.library.result?.session?.selections.length) {
      expect(host.textContent).toContain("release-notes · Alice");
    }
  });

  it.each([
    {
      name: "cached library refresh",
      view: "skills" as const,
      loading: true,
      busy: false,
      cleared: false,
    },
    {
      name: "reading or updating a pin",
      view: `library:${alice.entry.skillId}` as const,
      loading: false,
      busy: true,
      cleared: false,
    },
    {
      name: "adding a skill",
      view: "library-add" as const,
      loading: false,
      busy: true,
      cleared: false,
    },
    {
      name: "post-mutation reload",
      view: "skills" as const,
      loading: true,
      busy: true,
      cleared: true,
    },
  ])(
    "does not replace known content or add placeholders during $name",
    ({ view, loading, busy, cleared }) => {
      const state = withPin();
      state.loading = loading;
      state.busy = busy;
      if (cleared) {
        state.result = null;
      }
      const { host } = mount({ skills: [ordinary], library: state }, view);
      expect(host.querySelector(".skeleton")).toBeNull();
      expect(host.textContent).not.toMatch(/Loading/u);
      expect(host.querySelector("wa-dropdown")?.getAttribute("aria-busy")).toBe("true");
      if (!cleared) {
        expect(host.textContent).toContain("release-notes");
      }
    },
  );

  it("keeps the ordinary catalog visible during a refresh", () => {
    const { host, item } = mount({ skills: [ordinary], skillsLoading: true });
    expect(item("skill:0")).not.toBeNull();
    expect(host.querySelector(".skeleton")).toBeNull();
    expect(host.textContent).not.toMatch(/Loading/u);
  });

  it.each([false, true])(
    "keeps library failures actionable even with a cached empty result (%s)",
    (cached) => {
      const state = library({ error: "Library unavailable" });
      if (!cached) {
        state.result = null;
      }
      const { host, select } = mount({ skills: [ordinary], library: state });
      expect(host.textContent).toContain("Library unavailable");
      expect(host.textContent).toContain("weather");
      expect(host.textContent).not.toContain(t("chat.composer.menu.noSkills"));
      select("library-reload");
      expect(state.onReload).toHaveBeenCalledOnce();
    },
  );

  it("does not hide a selected private pin when ordinary skill discovery fails", () => {
    const { host, item } = mount({ skillsError: true, library: withPin() });
    expect(host.textContent).toContain(t("chat.composer.menu.skillsLoadFailed"));
    expect(item("library-selected:" + alice.entry.skillId)).not.toBeNull();
    expect(host.textContent).not.toContain(alice.entry.revision.slice(0, 8));
    expect(host.textContent).not.toContain(t("chat.composer.menu.noSkills"));
  });

  it("keeps adding separate from existing session availability", () => {
    const state = withPin();
    const main = mount({ library: state, skills: [ordinary] });
    expect(main.item("library-attach:" + bob.entry.skillId)).toBeNull();
    main.select("library-add");
    expect(main.changeView).toHaveBeenCalledWith("library-add");
    main.select("skill:0");
    expect(main.patch).toHaveBeenCalledWith({ skills: { weather: false } });
    expect(state.onActivate).not.toHaveBeenCalled();
    const add = mount({ library: state }, "library-add");
    add.select("library-attach:" + bob.entry.skillId);
    expect(state.onActivate).toHaveBeenCalledWith("attach", bob.entry.skillId, bob.entry.revision);
    expect(add.changeView).toHaveBeenCalledWith("skills");
    add.select("back");
    expect(add.changeView).toHaveBeenLastCalledWith("skills");
  });

  it.each([
    { accessible: false, updated: false, canWrite: true, refresh: false, remove: true },
    { accessible: true, updated: false, canWrite: true, refresh: false, remove: true },
    { accessible: true, updated: true, canWrite: true, refresh: true, remove: true },
    { accessible: true, updated: true, canWrite: false, refresh: false, remove: false },
  ])("offers only useful permitted actions: %j", (options) => {
    const state = withPin(options);
    const { host, item, select } = mount({ library: state }, `library:${alice.entry.skillId}`);
    expect(host.textContent).toContain(alice.entry.revision.slice(0, 8));
    expect(Boolean(item("library-refresh:" + alice.entry.skillId))).toBe(options.refresh);
    expect(Boolean(item("library-detach:" + alice.entry.skillId))).toBe(options.remove);
    select("library-read:" + alice.entry.skillId);
    expect(state.onRead).toHaveBeenCalledWith(alice.entry.skillId, alice.entry.revision);
    expect(state.onActivate).not.toHaveBeenCalled();
    if (!options.canWrite) {
      select("library-detach:" + alice.entry.skillId);
      expect(state.onActivate).not.toHaveBeenCalled();
      expect(mount({ library: state }).item("library-add")).toBeNull();
    }
  });

  it("explains the selection limit only in Add and never dispatches an over-limit attachment", () => {
    const state = withPin();
    const selections = Array.from({ length: 64 }, (_, index) => ({
      ...alice.entry,
      skillId: String(index),
    }));
    state.result = {
      ...state.result!,
      defaultSelectionNotice: "Future sessions use a limited default selection.",
      session: { sessionKey: "agent:main:review", selections, attachable: [bob.entry] },
    };
    const main = mount({ library: state });
    expect(main.host.textContent).not.toContain("64");
    expect(main.host.textContent).not.toContain("Future sessions");
    const add = mount({ library: state }, "library-add");
    expect(add.host.textContent).toContain("This chat has 64 library skills");
    expect(add.item("library-attach:" + bob.entry.skillId)?.hasAttribute("disabled")).toBe(true);
    add.select("library-attach:" + bob.entry.skillId);
    expect(state.onActivate).not.toHaveBeenCalled();
  });

  it("keeps unavailable skill reasons and read-only controls", () => {
    const { host, item, select, patch } = mount({
      skills: [{ ...ordinary, missingDeps: true }],
      mutationBlockedReason: "Read-only",
    });
    expect(item("skill:0")?.hasAttribute("disabled")).toBe(true);
    expect(host.textContent).toContain(t("chat.composer.menu.depsMissing"));
    select("skill:0");
    expect(patch).not.toHaveBeenCalled();
  });
});
