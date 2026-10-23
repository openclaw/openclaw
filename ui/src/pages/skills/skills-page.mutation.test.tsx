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
import { createProps, createReport, createSkill } from "./view.test-support.ts";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Skills mutation presentation", () => {
  it("settles an admitted toggle when its caller retires before the first presentation settle", async () => {
    const pending = deferred<unknown>();
    const report = createReport([createSkill({ disabled: true })]);
    const request = vi.fn(async (method: string) => {
      if (method === "skills.update") {
        return pending.promise;
      }
      if (method === "skills.status") {
        return report;
      }
      throw new Error(`Unexpected method: ${method}`);
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
    const operation = createRoot((dispose) => {
      const mutations = createSkillsMutationPresentation({
        state,
        readSkills: () => state.skillsReport,
        scope: () => ({ client, epoch: 1, agentId: "main", agentRevision: 0 }),
        readEpoch: () => 1,
        active: () => true,
      });
      const saving = mutations.run(() => updateSkillEnabled(state, "repo-skill", false), {
        skillKey: "repo-skill",
        enabled: false,
      });
      mutations.retire();
      dispose();
      return saving;
    });
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
      const request = vi.fn(async (method: string) => {
        if (method === "skills.update") {
          return pending.promise;
        }
        if (method === "skills.status") {
          return replacement;
        }
        if (method === "skills.library.list") {
          return { ...personalLibrary, defaultTarget: "workspace" };
        }
        if (method === "skills.search") {
          return { results: [] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const mounted = mountSkills(request, "settings");
      mounted.publishRouteData({ report: original });
      await waitForFast(() => expect(mounted.page.textContent).toContain("Original inventory"));
      mounted.page.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
      await waitForFast(() =>
        expect(mounted.page.querySelector('input[role="switch"]')).not.toBeNull(),
      );
      const toggle = mounted.page.querySelector<HTMLInputElement>('input[role="switch"]')!;
      toggle.click();
      await waitForFast(() => expect(toggle.disabled).toBe(true));

      if (change === "connection") {
        mounted.connection.publish({
          ...mounted.connection.gateway.snapshot,
          client: { request } as unknown as GatewayBrowserClient,
        });
        await waitForFast(() =>
          expect(mounted.page.textContent).toContain("Replacement inventory"),
        );
      } else if (change === "agent") {
        mounted.context.settingsAgentSelection.set("research");
        await waitForFast(() => {
          expect(mounted.page.textContent).not.toContain("Original inventory");
          expect(mounted.page.querySelector(".skill-reader-dialog")).toBeNull();
        });
      } else {
        await mounted.router.navigate("skills", mounted.context);
        mounted.changeSurface("discovery");
        await waitForFast(() =>
          expect(mounted.page.querySelector('input[name="skills-search"]')).not.toBeNull(),
        );
      }

      if (change === "agent") {
        // One owner serializes inventory reads behind the admitted workspace write.
        expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(0);
        pending.resolve({});
      }
      let successorDialog: Element | null = null;
      if (change !== "route") {
        await waitForFast(() =>
          expect(mounted.page.textContent).toContain("Replacement inventory"),
        );
        mounted.page.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
        await waitForFast(() => {
          const current = mounted.page.querySelector<HTMLInputElement>('input[role="switch"]');
          expect(current?.checked).toBe(true);
          expect(current?.disabled).toBe(false);
        });
        successorDialog = mounted.page.querySelector(".skill-reader-dialog");
      }
      if (change !== "agent") {
        pending.resolve({});
      }
      await pending.promise;
      if (change !== "route") {
        await waitForFast(() => {
          expect(mounted.page.querySelector(".skill-reader-dialog")).toBe(successorDialog);
          const current = mounted.page.querySelector<HTMLInputElement>('input[role="switch"]');
          expect(current?.checked).toBe(true);
          expect(current?.disabled).toBe(false);
          expect(mounted.page.textContent).not.toContain("Skill disabled");
          expect(mounted.page.textContent).toContain("Replacement inventory");
        });
      } else {
        expect(mounted.page.querySelector('input[name="skills-search"]')).not.toBeNull();
      }
    },
  );

  it.each(["success", "error"])(
    "retains the open skill and reconciles an optimistic toggle after %s",
    async (outcome) => {
      onTestFinished(installDialogPolyfill());
      const pending = deferred<unknown>();
      const skill = createSkill();
      let report = createReport([skill]);
      const request = vi.fn(async (method: string) => {
        if (method === "skills.update") {
          return pending.promise;
        }
        if (method === "skills.status") {
          return report;
        }
        if (method === "skills.library.list") {
          return { ...personalLibrary, defaultTarget: "workspace" };
        }
        if (method === "skills.search") {
          return { results: [] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { page, publishRouteData } = mountSkills(request, "settings");
      publishRouteData({ report });
      await waitForFast(() =>
        expect(
          page.querySelector<HTMLButtonElement>(".plugins-item__detail-button"),
        ).not.toBeNull(),
      );
      page.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
      await waitForFast(() => expect(page.querySelector(".skill-reader-dialog")).not.toBeNull());
      const dialog = page.querySelector(".skill-reader-dialog")!;
      const { dialog: nativeDialog } = await getRenderedModalDialog(page);
      const toggle = dialog.querySelector<HTMLInputElement>('input[role="switch"]')!;
      toggle.click();
      await waitForFast(() => {
        expect(toggle.disabled).toBe(true);
        expect(toggle.checked).toBe(false);
        expect(toggle.parentElement!.parentElement!.textContent).toContain("Disabled");
        expect(nativeDialog.open).toBe(true);
      });
      expect(request.mock.calls.filter(([method]) => method === "skills.update")).toHaveLength(1);
      expect(page.querySelector(".skill-reader-dialog")).toBe(dialog);

      if (outcome === "success") {
        report = createReport([createSkill({ disabled: true })]);
        pending.resolve({});
      } else {
        pending.reject(new Error("Synthetic rejected skill update"));
      }
      await waitForFast(() => {
        expect(toggle.disabled).toBe(false);
        expect(toggle.checked).toBe(outcome === "error");
      });
      expect(page.querySelector(".skill-reader-dialog")).toBe(dialog);
      expect(dialog.textContent).toContain(
        outcome === "success" ? "Skill disabled" : "Synthetic rejected skill update",
      );
      expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(
        outcome === "success" ? 1 : 0,
      );
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
      const request = vi.fn(async (method: string) => {
        if (method === "skills.update" || method === "skills.install") {
          return mutation.promise;
        }
        if (method === "skills.status") {
          return refreshed.promise;
        }
        if (method === "skills.library.list") {
          return { ...personalLibrary, defaultTarget: "workspace" };
        }
        if (method === "skills.search") {
          return { results: [remoteSkill] };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const { page, publishRouteData } = mountSkills(
        request,
        kind === "clawhub" ? "discovery" : "settings",
      );
      publishRouteData({ report });
      let control: HTMLButtonElement;
      if (kind === "clawhub") {
        await waitForFast(() =>
          expect(
            page.querySelector<HTMLButtonElement>(".plugin-catalog-card__install")?.disabled,
          ).toBe(false),
        );
        control = page.querySelector<HTMLButtonElement>(".plugin-catalog-card__install")!;
      } else {
        await waitForFast(() =>
          expect(page.querySelector(".plugins-item__detail-button")).not.toBeNull(),
        );
        page.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
        await waitForFast(() => expect(page.querySelector(".skill-reader-dialog")).not.toBeNull());
        if (kind === "key") {
          const input = page.querySelector<HTMLInputElement>('input[type="password"]')!;
          input.value = "synthetic-replacement";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          await waitForFast(() =>
            expect(
              page.querySelector<HTMLButtonElement>(".skill-reader-dialog__actions .primary")
                ?.disabled,
            ).toBe(false),
          );
          control = page.querySelector<HTMLButtonElement>(
            ".skill-reader-dialog__actions .primary",
          )!;
        } else {
          control = page.querySelector<HTMLButtonElement>(".skill-reader-dialog__actions .btn")!;
        }
      }
      control.click();
      await waitForFast(() => expect(control.disabled).toBe(true));
      mutation.resolve({});
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(1),
      );
      expect(control.disabled).toBe(true);
      refreshed.resolve(report);
      await waitForFast(() => expect(control.disabled).toBe(false));
      expect(control.isConnected).toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "skills.status")).toHaveLength(1);
    },
  );
});
