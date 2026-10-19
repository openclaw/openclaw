import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type {
  SkillLibraryEntry,
  SkillsLibraryListResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { registerSkillLibraryEnglish } from "../i18n/locales/en-skill-library.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createDevicesViewProps } from "../test-helpers/devices-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { DevicesView } from "./devices/view.tsx";
import { createSkillLibrary } from "./skills/library-state.ts";
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

it("does not rescan a large skill library for unrelated read errors while preserving search", async () => {
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
  let list: SkillsLibraryListResult = {
    entries,
    profileId: "person",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 4,
  };
  const request = vi.fn(async (method: string) => {
    if (method === "skills.library.list") {
      return list;
    }
    if (method === "skills.library.read") {
      throw new Error("Unrelated read feedback");
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const client = createTestGatewayClient(request);
  let library!: ReturnType<typeof createSkillLibrary>;
  const view = mountSolid(() => {
    library = createSkillLibrary({
      snapshot: {
        client,
        phase: "connected",
        offlineStable: false,
        hello: gatewayHelloForMethods([]),
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        sessionKey: "main",
        lastError: null,
        lastErrorCode: null,
      },
      capture: () => ({ client, epoch: 0 }),
      isCurrent: (scope) => scope.client === client && scope.epoch === 0,
    });
    return <SkillLibrary library={library} navigationActions={undefined} />;
  });
  await library.load();
  flush();
  const input = view.container.querySelector<HTMLInputElement>('[name="library-search"]')!;
  input.value = "skill";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  const first = view.container.querySelector(".plugins-item__detail-button");
  expect(first).not.toBeNull();
  input.focus();
  const { userEvent } = await import("vitest/browser");
  await userEvent.keyboard("{End} ");
  expect(input.value).toBe("skill ");
  input.setSelectionRange(1, 3);
  reads = 0;
  await library.open("audit-skill-0");
  flush();
  expect(view.container.textContent).toContain("Unrelated read feedback");
  expect(view.container.querySelector('[name="library-search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3]);
  expect(view.container.querySelector(".plugins-item__detail-button")).toBe(first);
  expect(reads).toBe(0);
  await userEvent.keyboard(
    navigator.platform === "MacIntel" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  expect(input.value).toBe("skill");
  expect(library.local.query).toBe("skill");
  list = {
    ...list,
    entries: entries.map((entry, index) =>
      index === 0 ? Object.assign({}, entry, { description: "Updated library receipt" }) : entry,
    ),
  };
  library.edit((state) => {
    state.list = list;
  });
  flush();
  expect(view.container.querySelector(".plugins-item__detail-button")).toBe(first);
  expect(view.container.querySelector('[name="library-search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("skill");
  expect(library.local.query).toBe("skill");
  expect(view.container.querySelector(".plugins-item__detail-button")?.textContent).toContain(
    "Updated library receipt",
  );
  input.value = "skill-239";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(view.container.querySelectorAll(".plugins-item__detail-button")).toHaveLength(1);
  expect(view.container.querySelector(".plugins-item__detail-button")?.textContent).toContain(
    "skill-239",
  );
});
