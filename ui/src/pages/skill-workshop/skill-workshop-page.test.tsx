import type { SkillsWorkshopListResult, SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.js";
import type { ApplicationContext } from "../../app/context.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext, createRuntimeConfigStub } from "./skill-workshop-page.test-support.ts";
import { SkillWorkshopPage } from "./skill-workshop-page.tsx";

const SKILL = "actual-budget-operations";
const VERSION = "20260929T010000000Z-patch";
const mutationAccess = { methods: ["skills.workshop.archive", "skills.workshop.restore"] };
const skillRead = { content: "Synthetic procedure", files: ["SKILL.md"] };
const skillTarget = { agentId: "research", name: SKILL };
const change: SkillWorkshopChange = {
  id: "change-1",
  agentId: "research",
  skillName: SKILL,
  action: "patch",
  actor: "review",
  summary: "tightened reconciliation step",
  versionId: VERSION,
  createdAtMs: Date.now() - 60_000,
};
const skill: SkillsWorkshopListResult["skills"][number] = {
  name: SKILL,
  description: "Use when reconciling Actual Budget accounts",
  updatedAtMs: change.createdAtMs,
  sizeBytes: 900,
  files: ["SKILL.md"],
  useCount: 3,
};
function archived(name = SKILL, id = VERSION, live = true) {
  return { name, live, versions: [{ id, action: change.action, createdAtMs: change.createdAtMs }] };
}
const list: SkillsWorkshopListResult = {
  agentId: "research",
  mode: "auto",
  root: "/agents/research/workshop-skills",
  skills: [skill],
  archived: [archived()],
};
type RequestParams = { agentId: string; name?: string; versionId?: string; filePath?: string };
type Replies = Record<string, object | ((params: RequestParams) => unknown)>;
function gateway(overrides: Replies = {}, changes: SkillWorkshopChange[] = [change]) {
  const replies: Replies = {
    list,
    changes: { changes },
    restore: { change: { ...change, id: "change-2", action: "restore", actor: "user" } },
    archive: { change: { ...change, id: "change-3", action: "archive", actor: "user" } },
    ...overrides,
  };
  return vi.fn((method: string, params: RequestParams) => {
    const reply =
      method === "config.get"
        ? replies[method]
        : method.startsWith("skills.workshop.")
          ? replies[method.slice("skills.workshop.".length)]
          : undefined;
    return reply
      ? Promise.resolve(typeof reply === "function" ? reply(params) : reply)
      : Promise.reject(new Error(`unexpected ${method}`));
  });
}
async function mount(
  input: ApplicationContext | ReturnType<typeof gateway>,
  options?: Parameters<typeof createContext>[1],
) {
  const context = typeof input === "function" ? createContext(input, options) : input;
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const page = mounted.container;
  await waitForSolid(() => expect(page.querySelector("button")).not.toBeNull());
  return page;
}
const text = (page: HTMLElement, selector: string) => page.querySelector(selector)?.textContent;
const loading = (page: HTMLElement) => page.querySelector(".settings-loading-skeleton");
const waitText = (page: HTMLElement, value: string) =>
  waitForSolid(() => expect(page.textContent).toContain(value));
function button(page: HTMLElement, label: string) {
  return Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
}
async function click(page: HTMLElement, label: string) {
  const control = await waitForSolid(() => {
    expect(button(page, label)).toBeDefined();
    return button(page, label)!;
  });
  control.click();
  return control;
}

it.each(["list", "file"])("ignores a retired %s failure", async (kind) => {
  const previous = createDeferredCore<SkillsWorkshopListResult | typeof skillRead>();
  const selected = createDeferredCore<SkillsWorkshopListResult | typeof skillRead>();
  const request = gateway({
    list:
      kind === "list"
        ? ({ agentId }) => (agentId === "research" ? previous.promise : selected.promise)
        : { ...list, skills: [skill, { ...skill, name: "release-notes" }] },
    read: ({ name }) => (kind === "file" && name === SKILL ? previous.promise : selected.promise),
    changes: { changes: [] },
  });
  const context = createContext(request);
  const page = await mount(context);
  if (kind === "list") {
    expect(loading(page)).not.toBeNull();
    context.agentSelection.set("scout");
    flush();
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("skills.workshop.list", { agentId: "scout" }),
    );
  } else {
    await waitForSolid(() => expect(text(page, ".sw-detail__title")).toBe(SKILL));
    page.querySelectorAll<HTMLButtonElement>(".sw-row__main")[1]!.click();
    selected.resolve({ ...skillRead, content: "Release notes procedure" });
    await waitText(page, "Release notes procedure");
  }
  previous.reject(new Error("Retired read failed"));
  await previous.promise.catch(() => undefined);
  flush();
  expect(page.textContent).not.toContain("Retired read failed");
  if (kind === "list") {
    expect(loading(page)).not.toBeNull();
    selected.resolve({ ...list, agentId: "scout", skills: [], archived: [] });
    await waitForSolid(() => expect(loading(page)).toBeNull());
    expect(page.querySelector('[role="alert"]')).toBeNull();
  } else {
    expect(text(page, ".sw-detail__title")).toBe("release-notes");
  }
});

it.each(["config", "library"])("retries %s only on request", async (source) => {
  const config = source === "config";
  const firstRead = createDeferredCore<unknown>();
  const retry = createDeferredCore<unknown>();
  const read = vi.fn().mockReturnValueOnce(firstRead.promise).mockReturnValue(retry.promise);
  const context = createContext(
    gateway({ [config ? "config.get" : "list"]: read, read: skillRead }),
    config ? { methods: ["config.patch"] } : undefined,
  );
  if (config) {
    const runtimeConfig = createRuntimeConfigCapability(context.gateway);
    onTestFinished(() => runtimeConfig.dispose());
    Object.assign(context, { runtimeConfig });
  }
  const page = await mount(context);
  const initialLoad = config ? context.runtimeConfig.ensureLoaded() : undefined;
  await waitForSolid(() => expect(read).toHaveBeenCalledOnce());
  firstRead.reject(new Error("Read unavailable"));
  await initialLoad;
  await waitText(page, "Read unavailable");
  expect(read).toHaveBeenCalledOnce();
  await click(page, "Retry");
  if (!config) {
    await waitForSolid(() => {
      expect(page.textContent).not.toContain("Read unavailable");
      expect(loading(page)).not.toBeNull();
    });
  }
  retry.resolve(config ? { config: {}, hash: "recovered", valid: true, issues: [] } : list);
  await waitForSolid(() => {
    expect(page.textContent).not.toContain("Read unavailable");
    if (config) {
      expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
    } else {
      expect(page.textContent).toContain("Synthetic procedure");
    }
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps a new agent's restore pending after a retired archive fails", async () => {
  const archive = createDeferredCore<unknown>();
  const restore = createDeferredCore<unknown>();
  const request = gateway({ archive: archive.promise, restore: restore.promise, read: skillRead });
  const context = createContext(request, mutationAccess);
  const page = await mount(context);
  await click(page, "Archive");
  flush();
  context.agentSelection.set("scout");
  flush();
  const restoreButton = await click(page, "Undo");
  flush();
  expect(restoreButton.disabled).toBe(true);
  archive.reject(new Error("Retired archive failed"));
  await archive.promise.catch(() => undefined);
  flush();
  expect(restoreButton.disabled).toBe(true);
  expect(page.textContent).not.toContain("Retired archive failed");
  restore.resolve({ change });
  await waitForSolid(() => expect(button(page, "Undo")?.disabled).toBe(false));
  expect(request).toHaveBeenCalledWith("skills.workshop.restore", {
    ...skillTarget,
    agentId: "scout",
    versionId: VERSION,
  });
});

it.each([
  { reason: "pruned version", versionId: "pruned", scopes: ["operator.admin"], action: "patch" },
  { reason: "no admin scope", versionId: VERSION, scopes: ["operator.read"], action: "patch" },
  { reason: "undo restore", versionId: undefined, scopes: ["operator.admin"], action: "restore" },
] as const)("gates undo: $reason", async ({ versionId, scopes, action }) => {
  const request = gateway({}, [{ ...change, versionId, action }]);
  const page = await mount(request, { ...mutationAccess, scopes: [...scopes] });
  await waitText(page, change.summary);
  if (action === "restore") {
    await click(page, "Undo");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("skills.workshop.archive", skillTarget),
    );
  } else {
    expect(button(page, "Undo")).toBeUndefined();
  }
});

it("opens an archived skill from a chat link", async () => {
  const versionId = "20260930T010000000Z-archive";
  const request = gateway(
    {
      list: { ...list, archived: [...list.archived, archived("release-notes", versionId, false)] },
      read: ({ agentId, name, filePath, versionId: id }) => ({
        ...skillRead,
        content: `${agentId}:${name}/${filePath}@${id}`,
      }),
    },
    [],
  );
  const page = await mount(request, { search: "?skill=release-notes" });
  await waitText(page, `research:release-notes/SKILL.md@${versionId}`);
  await waitForSolid(() => expect(page.querySelector(".sw-sort")).toBeNull());
});

it("compares saved metadata against today's", async () => {
  const skillFile = (description: string) =>
    `---\nname: ${SKILL}\ndescription: ${description}\n---\n\nSynthetic procedure`;
  const page = await mount(
    gateway({
      read: ({ versionId }) => ({
        ...skillRead,
        content: skillFile(versionId ? "Synthetic old summary" : skill.description),
      }),
    }),
  );
  await waitText(page, "Synthetic procedure");
  page.querySelectorAll<HTMLButtonElement>(".sw-tab")[2]!.click();
  flush();
  button(page, "Compare")!.click();
  await waitForSolid(() => expect(text(page, ".sw-detail__desc")).toBe("Synthetic old summary"));
  const diffText = (kind: "remove" | "add") =>
    Array.from(
      page.querySelectorAll(`.sw-diff__line--${kind} .sw-diff__text`),
      (line) => line.textContent,
    );
  expect(diffText("remove")).toContain("description: Synthetic old summary");
  expect(diffText("add")).toContain(`description: ${skill.description}`);
  expect(page.querySelector(".sw-diff__same")).toBeNull();
});

it.each([true, false])("sets learning mode (accepted: %s)", async (accepted) => {
  const patch = createDeferredCore<boolean>();
  const runtimeConfig = createRuntimeConfigStub({
    sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    patch: vi.fn(() => patch.promise),
  });
  runtimeConfig.state.lastError = "Mode update refused";
  const page = await mount(gateway({ read: skillRead }), {
    methods: ["config.patch"],
    runtimeConfig,
  });
  expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
  button(page, "Off")!.click();
  await waitForSolid(() => {
    expect(button(page, "Off")?.getAttribute("aria-pressed")).toBe("true");
    expect(button(page, "Off")?.getAttribute("aria-disabled")).toBe("true");
  });
  expect(runtimeConfig.patch).toHaveBeenCalledExactlyOnceWith({
    raw: { skills: { workshop: { autonomous: { mode: "off" } } } },
    note: "Disable Skill Workshop learning",
  });
  patch.resolve(accepted);
  if (accepted) {
    await waitForSolid(() => expect(runtimeConfig.refresh).toHaveBeenCalled());
  } else {
    await waitForSolid(() => {
      expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
      expect(button(page, "Auto")?.getAttribute("aria-disabled")).toBeNull();
      expect(page.textContent).toContain("Mode update refused");
    });
  }
});
