import { createSignal } from "solid-js";
import { afterEach, expect, it } from "vitest";
import { registerSkillLibraryEnglish } from "../i18n/locales/en-skill-library.ts";
import { registerEnglishCatalog } from "../lib/reactive/i18n.ts";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import { createDevicesViewProps } from "../test-helpers/devices-fixtures.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../test-helpers/gateway-methods.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { DevicesView } from "./devices/view.tsx";
import { createSkillLibrary } from "./skills/library-state.ts";
import { SkillLibrary } from "./skills/library-view.tsx";
import { libraryEntry, libraryList, requestFor } from "./skills/skills.test-support.ts";
registerEnglishCatalog(registerSkillLibraryEnglish);

afterEach(cleanupSolid);

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
  const [current, setCurrent] = createSignal(createDevicesViewProps({ nodes }));
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
  const entries = Array.from({ length: 240 }, (_, index) => ({
    ...libraryEntry({ shared: true }),
    skillId: "audit-skill-" + index,
    get slug() {
      reads += 1;
      return "skill-" + index;
    },
    name: "Skill " + index,
  }));
  const list = { ...libraryList(false), entries };
  const client = createTestGatewayClient(
    requestFor({
      "skills.library.list": () => list,
      "skills.library.read": () => {
        throw new Error("Unrelated read feedback");
      },
    }),
  );
  let library!: ReturnType<typeof createSkillLibrary>;
  const view = mountSolid(() => {
    library = createSkillLibrary({
      snapshot: {
        ...createApplicationGateway().gateway.snapshot,
        client,
        phase: "connected",
        hello: gatewayHelloForMethods([]),
        sessionKey: "main",
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
  const firstRow = () => view.container.querySelector(".plugins-item__detail-button");
  const first = firstRow();
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
  expect(firstRow()).toBe(first);
  expect(reads).toBe(0);
  await userEvent.keyboard(
    navigator.platform === "MacIntel" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
  );
  expect([input.value, library.local.query]).toEqual(["skill", "skill"]);
  library.edit((state) => {
    state.list = {
      ...list,
      entries: entries.map((entry, index) =>
        index === 0 ? Object.assign({}, entry, { description: "Updated library receipt" }) : entry,
      ),
    };
  });
  flush();
  expect(firstRow()).toBe(first);
  expect(view.container.querySelector('[name="library-search"]')).toBe(input);
  expect(document.activeElement).toBe(input);
  expect([input.value, library.local.query]).toEqual(["skill", "skill"]);
  expect(firstRow()?.textContent).toContain("Updated library receipt");
  input.value = "skill-239";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(view.container.querySelectorAll(".plugins-item__detail-button")).toHaveLength(1);
  expect(firstRow()?.textContent).toContain("skill-239");
});
