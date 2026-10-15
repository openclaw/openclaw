import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillLibraryEntry } from "../../../packages/gateway-protocol/src/index.ts";
import { registerSkillLibraryEnglish } from "../i18n/locales/en-skill-library.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createDevicesViewProps } from "../test-helpers/devices-fixtures.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { DevicesView } from "./devices/view.tsx";
import { SkillLibraryController } from "./skills/library-controller.ts";
import { SkillLibrary } from "./skills/library-view.tsx";
registerEnglishCatalog(registerSkillLibraryEnglish);

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

it("does not rebuild the large device inventory for unrelated config feedback", () => {
  let reads = 0;
  const nodes = Array.from({ length: 160 }, (_, index) => ({
    get nodeId() {
      reads += 1;
      return "node-" + index;
    },
    displayName: "Node " + index,
    paired: true,
    connected: true,
    platform: "linux",
    caps: [],
    commands: [],
  }));
  const initial = createDevicesViewProps({ nodes });
  const [current, setCurrent] = createSignal(initial);
  const view = mountSolid(() => <DevicesView {...current()} />);
  flush();
  const first = view.container.querySelector(".device-entry");
  expect(first).not.toBeNull();
  reads = 0;
  setCurrent((previous) => ({ ...previous, configDirty: true }));
  flush();
  expect(view.container.querySelector(".device-entry")).toBe(first);
  expect(reads).toBe(0);
  setCurrent((previous) => ({
    ...previous,
    nodes: nodes.map((node, index) =>
      index === 0 ? Object.assign({}, node, { version: "new-runtime" }) : node,
    ),
  }));
  flush();
  expect(view.container.querySelector(".device-entry")).toBe(first);
  expect(first?.textContent).toContain("new-runtime");
});

it("does not rescan a large skill library for unrelated feedback while preserving search", async () => {
  let reads = 0;
  const entries: SkillLibraryEntry[] = Array.from({ length: 240 }, (_, index) => ({
    skillId: "audit-skill-" + index,
    get slug() {
      reads += 1;
      return "skill-" + index;
    },
    name: "Skill " + index,
    description: "Synthetic library entry",
    ownerLabel: "Audit person",
    ownerProfileId: "person",
    authorProfileId: "person",
    shared: true,
    enabled: true,
    removed: false,
    revision: "a".repeat(64),
    createdAt: 1,
    updatedAt: 1,
    canEdit: true,
  }));
  const [revision, setRevision] = createSignal(0);
  const controller = new SkillLibraryController(
    { requestUpdate: () => setRevision((value) => value + 1) },
    {
      snapshot: null,
      capture: () => null,
      isCurrent: () => false,
    },
  );
  controller.list = {
    entries,
    profileId: "person",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 4,
  };
  controller.view = "all";
  controller.query = "skill";
  const library = new Proxy(controller, {
    get(target, key, receiver) {
      revision();
      return Reflect.get(target, key, receiver);
    },
  });
  const view = mountSolid(() => <SkillLibrary library={library} navigationActions={undefined} />);
  flush();
  const input = view.container.querySelector<HTMLInputElement>('[name="library-search"]')!;
  const first = view.container.querySelector(".plugins-item__detail-button");
  expect(first).not.toBeNull();
  input.focus();
  const { userEvent } = await import("vitest/browser");
  await userEvent.keyboard("{End} ");
  expect(input.value).toBe("skill ");
  input.setSelectionRange(1, 3);
  reads = 0;
  library.notice = "Unrelated upload notice";
  library.changed();
  flush();
  expect(view.container.textContent).toContain("Unrelated upload notice");
  expect(view.container.querySelector('[name="library-search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  expect(view.container.querySelector(".plugins-item__detail-button")).toBe(first);
  expect(reads).toBe(0);
  await userEvent.keyboard("{Control>}z{/Control}");
  expect(input.value).toBe("skill");
  expect(library.query).toBe("skill");
  library.list = {
    ...controller.list!,
    entries: entries.map((entry, index) =>
      index === 0 ? Object.assign({}, entry, { description: "Updated library receipt" }) : entry,
    ),
  };
  library.changed();
  flush();
  expect(view.container.querySelector(".plugins-item__detail-button")).toBe(first);
  expect(first?.textContent).toContain("Updated library receipt");
  library.query = "skill-239";
  library.changed();
  flush();
  expect(view.container.querySelectorAll(".plugins-item__detail-button")).toHaveLength(1);
  expect(view.container.querySelector(".plugins-item__detail-button")?.textContent).toContain(
    "skill-239",
  );
});
