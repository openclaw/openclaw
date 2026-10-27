import type { SkillsWorkshopListResult, SkillWorkshopChange } from "@openclaw/gateway-protocol";
import { getByRole, queryByRole } from "@solidjs/testing-library";
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
  const entries: Replies = {
    list,
    changes: { changes },
    restore: { change: { ...change, action: "restore" } },
    archive: { change: { ...change, action: "archive" } },
    ...overrides,
  };
  const replies: Replies = {};
  for (const [key, value] of Object.entries(entries)) {
    replies[key === "config.get" ? key : `skills.workshop.${key}`] = value;
  }
  return vi.fn((method: string, params: RequestParams) => {
    const reply = replies[method];
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
  return waitForSolid(() => mounted.container);
}
const text = (page: HTMLElement, selector: string) => page.querySelector(selector)?.textContent;
const loading = (page: HTMLElement) => page.querySelector(".settings-loading-skeleton");
const waitText = (page: HTMLElement, value: string) =>
  waitForSolid(() => expect(page.textContent).toContain(value));
const button = (page: HTMLElement, name: string, pressed?: boolean) =>
  queryByRole<HTMLButtonElement>(page, "button", { name, pressed });
async function click(page: HTMLElement, label: string | RegExp) {
  const control = await waitForSolid(() =>
    getByRole<HTMLButtonElement>(page, "button", { name: label }),
  );
  control.click();
  return control;
}

type Reply = SkillsWorkshopListResult | typeof skillRead | { change: SkillWorkshopChange };
it.each(["list", "file", "mutation"])("ignores a retired %s failure", async (kind) => {
  const previous = createDeferredCore<Reply>();
  const selected = createDeferredCore<Reply>();
  const request = gateway({
    list:
      kind === "file"
        ? { ...list, skills: [skill, { ...skill, name: "release-notes" }] }
        : kind === "list"
          ? ({ agentId }) => (agentId === "research" ? previous.promise : selected.promise)
          : list,
    read: ({ name }) =>
      kind !== "file" ? skillRead : name === SKILL ? previous.promise : selected.promise,
    archive: previous.promise,
    restore: selected.promise,
    changes: { changes: kind === "mutation" ? [change] : [] },
  });
  const context = createContext(request, kind === "mutation" ? mutationAccess : undefined);
  const page = await mount(context);
  if (kind === "mutation") {
    await click(page, "Archive");
    flush();
  }
  if (kind === "file") {
    await waitForSolid(() => expect(text(page, ".sw-detail__title")).toBe(SKILL));
    page.querySelectorAll<HTMLButtonElement>(".sw-row__main")[1]!.click();
    selected.resolve({ ...skillRead, content: "Release notes procedure" });
    await waitText(page, "Release notes procedure");
  } else {
    context.agentSelection.set("scout");
    flush();
  }
  const restoreButton = kind === "mutation" ? await click(page, "Undo") : null;
  if (kind === "mutation") {
    flush();
    expect(restoreButton?.disabled).toBe(true);
  }
  previous.reject(new Error("Retired read failed"));
  await previous.promise.catch(() => undefined);
  flush();
  expect(page.textContent).not.toContain("Retired read failed");
  if (kind === "list") {
    expect(loading(page)).not.toBeNull();
    selected.resolve({ ...list, agentId: "scout", skills: [], archived: [] });
    await waitForSolid(() => expect(loading(page)).toBeNull());
  } else if (kind === "file") {
    expect(text(page, ".sw-detail__title")).toBe("release-notes");
  } else {
    expect(restoreButton?.disabled).toBe(true);
    selected.resolve({ change });
    await waitForSolid(() => expect(button(page, "Undo")?.disabled).toBe(false));
    expect(request).toHaveBeenCalledWith("skills.workshop.restore", {
      ...skillTarget,
      agentId: "scout",
      versionId: VERSION,
    });
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
  await waitForSolid(() => expect(read).toHaveBeenCalledOnce());
  firstRead.reject(new Error("Read unavailable"));
  await waitText(page, "Read unavailable");
  expect(read).toHaveBeenCalledOnce();
  await click(page, "Retry");
  if (!config) {
    await waitForSolid(() => expect(loading(page)).not.toBeNull());
    expect(page.textContent).not.toContain("Read unavailable");
  }
  retry.resolve(config ? { config: {}, hash: "recovered", valid: true, issues: [] } : list);
  if (config) {
    await waitForSolid(() => expect(button(page, "Auto", true)).not.toBeNull());
  } else {
    await waitText(page, "Synthetic procedure");
  }
  expect(page.textContent).not.toContain("Read unavailable");
  expect(read).toHaveBeenCalledTimes(2);
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
    expect(button(page, "Undo")).toBeNull();
  }
});

it("opens an archived skill from a chat link", async () => {
  const versionId = "20260930T010000000Z-archive";
  const request = gateway({
    list: { ...list, archived: [...list.archived, archived("release-notes", versionId, false)] },
    read: ({ agentId, name, filePath, versionId: id }) => ({
      ...skillRead,
      content: `${agentId}:${name}/${filePath}@${id}`,
    }),
    changes: { changes: [] },
  });
  const page = await mount(request, { search: "?skill=release-notes" });
  await waitText(page, `research:release-notes/SKILL.md@${versionId}`);
  await waitForSolid(() => expect(page.querySelector(".sw-sort")).toBeNull());
});

it("compares saved metadata against today's", async () => {
  const read = ({ versionId }: RequestParams) => ({
    ...skillRead,
    content: `---\ndescription: ${versionId ? "Before" : skill.description}\n---\n`,
  });
  const page = await mount(gateway({ read }));
  await click(page, /^History/);
  await click(page, "Compare");
  await waitForSolid(() => expect(text(page, ".sw-detail__desc")).toBe("Before"));
  const diffText = (kind: "remove" | "add") =>
    Array.from(
      page.querySelectorAll(`.sw-diff__line--${kind} .sw-diff__text`),
      (line) => line.textContent,
    );
  expect(diffText("remove")).toContain("description: Before");
  expect(diffText("add")).toContain(`description: ${skill.description}`);
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
  button(page, "Off")!.click();
  await waitForSolid(() =>
    expect(button(page, "Off", true)?.getAttribute("aria-disabled")).toBe("true"),
  );
  expect(runtimeConfig.patch.mock.lastCall?.[0].raw.skills.workshop.autonomous.mode).toBe("off");
  patch.resolve(accepted);
  if (accepted) {
    await waitForSolid(() => expect(runtimeConfig.refresh).toHaveBeenCalled());
  } else {
    await waitForSolid(() => {
      expect(button(page, "Auto", true)?.getAttribute("aria-disabled")).toBeNull();
      expect(page.textContent).toContain("Mode update refused");
    });
  }
});
