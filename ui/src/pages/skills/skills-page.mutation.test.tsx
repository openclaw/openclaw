// @vitest-environment jsdom
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { updateSkillEnabled, type SkillsState } from "../../lib/skills/index.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../../test-helpers/modal-dialog.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSkillsMutationPresentation } from "./mutation-presentation.ts";
import { mountSkills, personalLibrary, remoteSkill } from "./skills-page.test-support.tsx";
import { requestFor } from "./skills.test-support.ts";
import { createProps, createReport, createSkill } from "./view.test-support.ts";

function mutationRequest(
  mutation: Promise<unknown>,
  status: () => unknown,
  results?: (typeof remoteSkill)[],
) {
  return requestFor({
    "skills.update": () => mutation,
    ...(results ? { "skills.install": () => mutation } : {}),
    "skills.status": status,
    "skills.library.list": () => ({ ...personalLibrary, defaultTarget: "workspace" }),
    "skills.search": () => ({ results: results ?? [] }),
  });
}
function callCount(request: ReturnType<typeof requestFor>, method: string) {
  return request.mock.calls.filter(([called]) => called === method).length;
}
function query<T extends Element = HTMLElement>(page: Element, selector: string) {
  return page.querySelector<T>(selector);
}
const reader = (page: Element) => query(page, ".skill-reader-dialog");
const toggleIn = (page: Element) => query<HTMLInputElement>(page, 'input[role="switch"]');
async function openReader(page: Element) {
  await waitForFast(() => expect(query(page, ".plugins-item__detail-button")).not.toBeNull());
  query<HTMLButtonElement>(page, ".plugins-item__detail-button")!.click();
  await waitForFast(() => expect(reader(page)).not.toBeNull());
  return reader(page)!;
}
function expectToggle(toggle: HTMLInputElement, checked: boolean, pending: boolean) {
  expect(toggle).toMatchObject({ checked, disabled: false });
  expect(toggle.getAttribute("aria-disabled")).toBe(pending ? "true" : null);
  expect(document.activeElement).toBe(toggle);
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Skills mutation presentation", () => {
  it("settles an admitted toggle when its caller retires before the first presentation settle", async () => {
    const pending = deferred<unknown>();
    const report = createReport([createSkill({ disabled: true })]);
    const request = requestFor({
      "skills.update": () => pending.promise,
      "skills.status": () => report,
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { state } = createProps();
    Object.assign(state, {
      client,
      skillsAgentId: "main",
      runtimeConfig: {
        runExternalMutation: async (task) => ({
          ok: true,
          value: await task(client),
          refresh: { ok: true },
        }),
      } satisfies SkillsState["runtimeConfig"],
    });
    const owner = createRoot((dispose) => {
      const mutations = createSkillsMutationPresentation({
        state,
        readSkills: () => state.skillsReport,
        scope: () => ({ client, epoch: 1, agentId: "main", agentRevision: 0 }),
        readEpoch: () => 1,
        active: () => true,
      });
      return { mutations, dispose };
    });
    const operation = owner.mutations.run(() => updateSkillEnabled(state, "repo-skill", false), {
      skillKey: "repo-skill",
      enabled: false,
    });
    owner.mutations.retire();
    owner.dispose();
    const completed = vi.fn();
    void operation.then(completed);
    pending.resolve({});
    await waitForFast(() => expect(completed).toHaveBeenCalledTimes(1));
    expect(state.skillsReport?.skills[0]?.disabled).toBe(true);
    expect(state.skillOperation).toBeNull();
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "skills.update",
      "skills.status",
    ]);
  });

  it.each(["connection", "agent", "route"])(
    "releases a held toggle presentation when the %s changes",
    async (change) => {
      const pending = deferred<unknown>();
      const original = createReport([createSkill({ name: "Original inventory" })]);
      const replacement = createReport([createSkill({ name: "Replacement inventory" })]);
      const request = mutationRequest(pending.promise, () => replacement);
      const mounted = mountSkills(request, "settings");
      const page = mounted.page;
      mounted.publishRouteData({ report: original });
      await waitForFast(() => expect(page.textContent).toContain("Original inventory"));
      query<HTMLButtonElement>(page, ".plugins-item__detail-button")!.click();
      await waitForFast(() => expect(toggleIn(page)).not.toBeNull());
      const toggle = toggleIn(page)!;
      toggle.click();
      await waitForFast(() => expect(toggle.getAttribute("aria-disabled")).toBe("true"));

      if (change === "connection") {
        mounted.connection.publish({
          ...mounted.connection.gateway.snapshot,
          client: { request } as unknown as GatewayBrowserClient,
        });
        await waitForFast(() => expect(page.textContent).toContain("Replacement inventory"));
      } else if (change === "agent") {
        mounted.context.settingsAgentSelection.set("research");
        await waitForFast(() => {
          expect(page.textContent).not.toContain("Original inventory");
          expect(reader(page)).toBeNull();
        });
      } else {
        await mounted.router.navigate("skills", mounted.context);
        mounted.changeSurface("discovery");
        await waitForFast(() => expect(query(page, 'input[name="skills-search"]')).not.toBeNull());
      }

      if (change === "agent") {
        // One owner serializes inventory reads behind the admitted workspace write.
        expect(callCount(request, "skills.status")).toBe(0);
        pending.resolve({});
      }
      let successorDialog: Element | null = null;
      if (change !== "route") {
        await waitForFast(() => expect(page.textContent).toContain("Replacement inventory"));
        query<HTMLButtonElement>(page, ".plugins-item__detail-button")!.click();
        await waitForFast(() => {
          const current = toggleIn(page);
          expect(current?.checked).toBe(true);
          expect(current?.getAttribute("aria-disabled")).toBeNull();
        });
        successorDialog = reader(page);
      }
      if (change !== "agent") {
        pending.resolve({});
      }
      await pending.promise;
      if (change !== "route") {
        await waitForFast(() => {
          expect(reader(page)).toBe(successorDialog);
          const current = toggleIn(page);
          expect(current?.checked).toBe(true);
          expect(current?.getAttribute("aria-disabled")).toBeNull();
          expect(page.textContent).not.toContain("Skill disabled");
          expect(page.textContent).toContain("Replacement inventory");
        });
      } else {
        expect(query(page, 'input[name="skills-search"]')).not.toBeNull();
      }
    },
  );

  it.each(["success", "error"])(
    "retains the open skill and reconciles an optimistic toggle after %s",
    async (outcome) => {
      onTestFinished(installDialogPolyfill());
      const pending = deferred<unknown>();
      let report = createReport([createSkill()]);
      const refreshed = deferred<ReturnType<typeof createReport>>();
      onTestFinished(() => {
        pending.resolve({});
        refreshed.resolve(report);
      });
      const request = mutationRequest(pending.promise, () => refreshed.promise);
      const { page, publishRouteData } = mountSkills(request, "settings");
      publishRouteData({ report });
      const dialog = await openReader(page);
      const { dialog: nativeDialog } = await getRenderedModalDialog(page);
      const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]')!;
      const disabledChanges: MutationRecord[] = [];
      const observer = new MutationObserver((records) => disabledChanges.push(...records));
      observer.observe(toggle, { attributes: true, attributeFilter: ["disabled"] });
      onTestFinished(() => observer.disconnect());
      toggle.focus();
      toggle.click();
      await waitForFast(() => {
        expectToggle(toggle, false, true);
        expect(toggle.parentElement!.parentElement!.textContent).toContain("Disabled");
        expect(nativeDialog.open).toBe(true);
      });
      toggle.click();
      expect(callCount(request, "skills.update")).toBe(1);
      expect(reader(page)).toBe(dialog);

      if (outcome === "success") {
        report = createReport([createSkill({ disabled: true })]);
        pending.resolve({});
        await waitForFast(() => expect(callCount(request, "skills.status")).toBe(1));
        expectToggle(toggle, false, true);
        refreshed.resolve(report);
      } else {
        pending.reject(new Error("Synthetic rejected skill update"));
      }
      await waitForFast(() => expectToggle(toggle, outcome === "error", false));
      expect(reader(page)).toBe(dialog);
      disabledChanges.push(...observer.takeRecords());
      expect(disabledChanges).toHaveLength(0);
      expect(dialog.textContent).toContain(
        outcome === "success" ? "Skill disabled" : "Synthetic rejected skill update",
      );
      expect(callCount(request, "skills.status")).toBe(outcome === "success" ? 1 : 0);
    },
  );

  it.each(["key", "dependency", "clawhub"])(
    "keeps the %s install/save controls locked through accepted inventory reconciliation",
    async (kind) => {
      const mutation = deferred<unknown>();
      const refreshed = deferred<ReturnType<typeof createReport>>();
      const skill = createSkill({
        missing: { anyBins: [], bins: ["fixture-cli"], env: [], config: [], os: [] },
        install: [
          { id: "fixture-cli", kind: "node", label: "Install fixture-cli", bins: ["fixture-cli"] },
        ],
      });
      const report = createReport([skill]);
      const request = mutationRequest(mutation.promise, () => refreshed.promise, [remoteSkill]);
      const { page, publishRouteData } = mountSkills(
        request,
        kind === "clawhub" ? "discovery" : "settings",
      );
      publishRouteData({ report });
      let control: HTMLButtonElement;
      if (kind === "clawhub") {
        const install = () => query<HTMLButtonElement>(page, ".plugin-catalog-card__install");
        await waitForFast(() => expect(install()?.disabled).toBe(false));
        control = install()!;
      } else {
        await openReader(page);
        if (kind === "key") {
          const input = query<HTMLInputElement>(page, 'input[type="password"]')!;
          input.value = "synthetic-replacement";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          const save = () =>
            query<HTMLButtonElement>(page, ".skill-reader-dialog__actions .primary");
          await waitForFast(() => expect(save()?.disabled).toBe(false));
          control = save()!;
        } else {
          control = query<HTMLButtonElement>(page, ".skill-reader-dialog__actions .btn")!;
        }
      }
      control.click();
      await waitForFast(() => expect(control.disabled).toBe(true));
      if (kind !== "clawhub") {
        expect(toggleIn(page)?.disabled).toBe(true);
      }
      mutation.resolve({});
      await waitForFast(() => expect(callCount(request, "skills.status")).toBe(1));
      expect(control.disabled).toBe(true);
      if (kind !== "clawhub") {
        expect(toggleIn(page)?.disabled).toBe(true);
      }
      refreshed.resolve(report);
      await waitForFast(() => expect(control.disabled).toBe(false));
      expect(control.isConnected).toBe(true);
      expect(callCount(request, "skills.status")).toBe(1);
    },
  );
});
