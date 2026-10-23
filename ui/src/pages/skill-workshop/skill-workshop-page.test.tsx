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
  updatedAtMs: Date.now() - 60_000,
  sizeBytes: 900,
  files: ["SKILL.md"],
  useCount: 3,
};
const version = { id: VERSION, action: change.action, createdAtMs: change.createdAtMs };
const list: SkillsWorkshopListResult = {
  agentId: "research",
  mode: "auto",
  root: "/agents/research/workshop-skills",
  skills: [skill],
  archived: [{ name: SKILL, live: true, versions: [version] }],
};
type RequestParams = { agentId: string; versionId?: string };
type Replies = Record<string, object | ((params: RequestParams) => unknown)>;
function requests(replies: Replies) {
  return vi.fn((method: string, params: RequestParams) => {
    const reply = replies[method];
    if (!reply) {
      return Promise.reject(new Error(`unexpected ${method}`));
    }
    return Promise.resolve(typeof reply === "function" ? reply(params) : reply);
  });
}
function workshopGateway(overrides: Replies = {}, changes: SkillWorkshopChange[] = [change]) {
  return requests({
    "skills.workshop.list": list,
    "skills.workshop.changes": { changes },
    "skills.workshop.restore": {
      change: { ...change, id: "change-2", action: "restore", actor: "user" },
    },
    "skills.workshop.archive": {
      change: { ...change, id: "change-3", action: "archive", actor: "user" },
    },
    ...overrides,
  });
}
async function mount(
  input: ApplicationContext | ReturnType<typeof workshopGateway>,
  options?: Parameters<typeof createContext>[1],
) {
  const context = typeof input === "function" ? createContext(input, options) : input;
  const mounted = mountSolid(() => <SkillWorkshopPage />, {
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  const page = mounted.container.querySelector<HTMLElement>("openclaw-skill-workshop-page")!;
  await waitForSolid(() => expect(page.querySelector("button")).not.toBeNull());
  return page;
}
function button(page: HTMLElement, label: string) {
  return Array.from(page.querySelectorAll("button")).find(
    (entry) => entry.textContent?.trim() === label,
  );
}

it("keeps the selected agent loading when the former agent's list fails", async () => {
  const previousList = createDeferredCore<SkillsWorkshopListResult>();
  const selectedList = createDeferredCore<SkillsWorkshopListResult>();
  const request = requests({
    "skills.workshop.list": ({ agentId }) =>
      agentId === "research" ? previousList.promise : selectedList.promise,
    "skills.workshop.changes": { changes: [] },
  });
  const context = createContext(request);
  const page = await mount(context);
  expect(page.querySelector(".settings-loading-skeleton")).not.toBeNull();
  context.agentSelection.set("scout");
  flush();
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("skills.workshop.list", { agentId: "scout" }),
  );
  previousList.reject(new Error("Former agent list failed"));
  await previousList.promise.catch(() => undefined);
  await waitForSolid(() => {
    expect(page.textContent).not.toContain("Former agent list failed");
    expect(page.querySelector(".settings-loading-skeleton")).not.toBeNull();
  });
  selectedList.resolve({ ...list, agentId: "scout", skills: [], archived: [] });
  await waitForSolid(() => expect(page.querySelector(".settings-loading-skeleton")).toBeNull());
  expect(page.querySelector('[role="alert"]')).toBeNull();
});

it("shows a failed configuration read and retries only when requested", async () => {
  const firstRead = createDeferredCore<unknown>();
  const configRead = vi
    .fn()
    .mockReturnValueOnce(firstRead.promise)
    .mockResolvedValue({ config: {}, hash: "recovered", valid: true, issues: [] });
  const request = workshopGateway({ "config.get": configRead, "skills.workshop.read": skillRead });
  const context = createContext(request, { methods: ["config.patch"] });
  const runtimeConfig = createRuntimeConfigCapability(context.gateway);
  onTestFinished(() => runtimeConfig.dispose());
  Object.assign(context, { runtimeConfig });
  const page = await mount(context);
  const initialLoad = runtimeConfig.ensureLoaded();
  firstRead.reject(new Error("Configuration temporarily unavailable"));
  await initialLoad;
  flush();
  expect(configRead).toHaveBeenCalledOnce();
  expect(page.querySelector('[role="alert"]')?.textContent).toContain(
    "Configuration temporarily unavailable",
  );
  const retry = button(page, "Retry");
  expect(retry).toBeDefined();
  retry!.click();
  expect(configRead).toHaveBeenCalledTimes(2);
  await runtimeConfig.ensureLoaded();
  flush();
  expect(configRead).toHaveBeenCalledTimes(2);
  expect(runtimeConfig.state.configSnapshot?.hash).toBe("recovered");
  expect(page.textContent).not.toContain("Configuration temporarily unavailable");
  expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
});

it("undoes restoring an archived skill by archiving it again", async () => {
  const request = workshopGateway({}, [{ ...change, action: "restore", versionId: undefined }]);
  const page = await mount(request, mutationAccess);
  await vi.waitFor(() => expect(button(page, "Undo")).toBeDefined());
  button(page, "Undo")?.click();
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("skills.workshop.archive", skillTarget),
  );
});

it("keeps a new agent's restore pending when the former agent's archive fails", async () => {
  const archive = createDeferredCore<unknown>();
  const restore = createDeferredCore<unknown>();
  const request = workshopGateway({
    "skills.workshop.archive": archive.promise,
    "skills.workshop.restore": restore.promise,
    "skills.workshop.read": skillRead,
  });
  const context = createContext(request, mutationAccess);
  const page = await mount(context);
  await vi.waitFor(() => expect(button(page, "Archive")).toBeDefined());
  button(page, "Archive")!.click();
  flush();
  context.agentSelection.set("scout");
  flush();
  await vi.waitFor(() => expect(button(page, "Undo")).toBeDefined());
  const restoreButton = button(page, "Undo")!;
  restoreButton.click();
  flush();
  expect(restoreButton.disabled).toBe(true);
  archive.reject(new Error("Retired archive failed"));
  await archive.promise.catch(() => undefined);
  flush();
  expect(restoreButton.disabled).toBe(true);
  expect(page.textContent).not.toContain("Retired archive failed");
  restore.resolve({ change });
  await vi.waitFor(() => expect(button(page, "Undo")?.disabled).toBe(false));
  expect(request).toHaveBeenCalledWith("skills.workshop.restore", {
    ...skillTarget,
    agentId: "scout",
    versionId: VERSION,
  });
});

it.each([
  { reason: "the saved version was pruned", versionId: "pruned", scopes: ["operator.admin"] },
  { reason: "the operator lacks admin scope", versionId: VERSION, scopes: ["operator.read"] },
])("offers no undo when $reason", async ({ versionId, scopes }) => {
  const page = await mount(workshopGateway({}, [{ ...change, versionId }]), {
    ...mutationAccess,
    scopes,
  });
  await vi.waitFor(() => expect(page.textContent).toContain(change.summary));
  expect(button(page, "Undo")).toBeUndefined();
});

it("opens the skill a chat notice links to, even when it is archived", async () => {
  const archivedVersion = "20260930T010000000Z-archive";
  const request = requests({
    "skills.workshop.list": {
      ...list,
      archived: [
        ...list.archived,
        {
          name: "release-notes",
          live: false,
          versions: [
            { ...version, id: archivedVersion, action: "archive", createdAtMs: Date.now() },
          ],
        },
      ],
    },
    "skills.workshop.changes": { changes: [] },
    "skills.workshop.read": { content: "", files: ["SKILL.md"] },
  });
  const page = await mount(request, { search: "?skill=release-notes" });
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("skills.workshop.read", {
      ...skillTarget,
      name: "release-notes",
      filePath: "SKILL.md",
      versionId: archivedVersion,
    }),
  );
  expect(request).not.toHaveBeenCalledWith(
    "skills.workshop.read",
    expect.objectContaining({ name: SKILL }),
  );
  await vi.waitFor(() => expect(page.querySelector(".sw-sort")).toBeNull());
});

it("compares a saved version's own metadata against today's", async () => {
  const skillFile = (description: string) =>
    `---\nname: ${SKILL}\ndescription: ${description}\n---\n\nSynthetic procedure`;
  const request = workshopGateway({
    "skills.workshop.read": ({ versionId }) => ({
      ...skillRead,
      content: skillFile(versionId ? "Synthetic old summary" : skill.description),
    }),
  });
  const page = await mount(request);
  await vi.waitFor(() => expect(page.textContent).toContain("Synthetic procedure"));
  page.querySelectorAll<HTMLButtonElement>(".sw-tab")[2]!.click();
  flush();
  button(page, "Compare")!.click();
  await vi.waitFor(() =>
    expect(page.querySelector(".sw-detail__desc")?.textContent).toBe("Synthetic old summary"),
  );
  const diffText = (kind: "remove" | "add") =>
    Array.from(
      page.querySelectorAll(`.sw-diff__line--${kind} .sw-diff__text`),
      (line) => line.textContent,
    );
  expect(diffText("remove")).toContain("description: Synthetic old summary");
  expect(diffText("add")).toContain(`description: ${skill.description}`);
  expect(page.querySelector(".sw-diff__same")).toBeNull();
});

it("switches the learning mode through the config key", async () => {
  const runtimeConfig = createRuntimeConfigStub({
    sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
  });
  const page = await mount(workshopGateway(), { methods: ["config.patch"], runtimeConfig });
  expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
  button(page, "Off")?.click();
  await vi.waitFor(() => expect(runtimeConfig.refresh).toHaveBeenCalled());
  expect(runtimeConfig.patch).toHaveBeenCalledExactlyOnceWith({
    raw: { skills: { workshop: { autonomous: { mode: "off" } } } },
    note: "Disable Skill Workshop learning",
  });
});

it("shows loading while retrying a failed library read", async () => {
  const retry = createDeferredCore<SkillsWorkshopListResult>();
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Library unavailable"))
    .mockReturnValue(retry.promise);
  const request = workshopGateway({
    "skills.workshop.list": read,
    "skills.workshop.read": skillRead,
  });
  const page = await mount(request);
  await waitForSolid(() => expect(page.textContent).toContain("Library unavailable"));
  button(page, "Retry")!.click();
  await waitForSolid(() => {
    expect(page.textContent).not.toContain("Library unavailable");
    expect(page.querySelector(".settings-loading-skeleton")).not.toBeNull();
  });
  expect(button(page, "Learn from history")).toBeDefined();
  retry.resolve(list);
  await waitForSolid(() => expect(page.textContent).toContain("Synthetic procedure"));
  expect(read).toHaveBeenCalledTimes(2);
});

it("retires a failed file read when another skill is selected", async () => {
  const previous = createDeferredCore<typeof skillRead>();
  const request = workshopGateway({
    "skills.workshop.list": { ...list, skills: [skill, { ...skill, name: "release-notes" }] },
    "skills.workshop.read": (params) =>
      "name" in params && params.name === SKILL
        ? previous.promise
        : { ...skillRead, content: "Release notes procedure" },
  });
  const page = await mount(request);
  await waitForSolid(() =>
    expect(page.querySelector(".sw-detail__title")?.textContent).toBe(SKILL),
  );
  const next = Array.from(page.querySelectorAll<HTMLButtonElement>(".sw-row__main")).find((entry) =>
    entry.textContent?.includes("release-notes"),
  )!;
  next.click();
  await waitForSolid(() => expect(page.textContent).toContain("Release notes procedure"));
  previous.reject(new Error("Retired file unavailable"));
  await previous.promise.catch(() => undefined);
  flush();
  expect(page.textContent).not.toContain("Retired file unavailable");
  expect(page.querySelector(".sw-detail__title")?.textContent).toBe("release-notes");
});

it("optimistically selects a learning mode and restores the owner value after rejection", async () => {
  const patch = createDeferredCore<boolean>();
  const runtimeConfig = createRuntimeConfigStub({
    sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    patch: vi.fn(() => patch.promise),
  });
  runtimeConfig.state.lastError = "Mode update refused";
  const page = await mount(workshopGateway({ "skills.workshop.read": skillRead }), {
    methods: ["config.patch"],
    runtimeConfig,
  });
  button(page, "Off")!.click();
  await waitForSolid(() => {
    expect(button(page, "Off")?.getAttribute("aria-pressed")).toBe("true");
    expect(button(page, "Off")?.getAttribute("aria-disabled")).toBe("true");
  });
  expect(runtimeConfig.patch).toHaveBeenCalledOnce();
  patch.resolve(false);
  await waitForSolid(() => {
    expect(button(page, "Auto")?.getAttribute("aria-pressed")).toBe("true");
    expect(button(page, "Auto")?.getAttribute("aria-disabled")).toBeNull();
    expect(page.textContent).toContain("Mode update refused");
  });
});
