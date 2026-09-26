import { ContextProvider } from "@lit/context";
import { createRouter } from "@openclaw/uirouter";
import { html, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import "../../app/router-outlet.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import { inspectResult, manifest } from "../../test-helpers/skill-workshop-proposal-fixture.ts";
import { skillWorkshopRevisionAdmissionsFor } from "./revision-recovery.ts";
import { page as skillWorkshopRoute } from "./route.ts";
import "./skill-workshop-page.ts";
import {
  createContext,
  type SkillWorkshopPageTestElement,
} from "./skill-workshop-page.test-support.ts";

beforeEach(() => {
  localStorage.setItem("openclaw:control-ui:skill-workshop-mode:v1", "suggestions");
});
afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("Workshop route refresh", () => {
  it("loads proposals before restoring a retained failed revision on mount", async () => {
    const response = createDeferred<ReturnType<typeof manifest>>();
    const request = vi.fn(async (method: string) =>
      method === "skills.proposals.list" ? response.promise : inspectResult(),
    );
    const context = createContext(request, {
      methods: ["skills.proposals.list", "skills.proposals.inspect"],
    });
    const instructions = "Preserve these revision instructions after returning.";
    await skillWorkshopRevisionAdmissionsFor(context).start(
      {
        instructions,
        proposalAgentId: "research",
        proposalId: "proposal-1",
        proposalSlug: "inbox-cleaner",
      },
      async () => {
        throw new Error("Revision admission failed");
      },
    ).completion;
    const page = document.createElement(
      "openclaw-skill-workshop-page",
    ) as SkillWorkshopPageTestElement;
    page.context = context;
    document.body.append(page);
    try {
      await settleLitElement(page);
      expect(
        request.mock.calls.filter(([method]) => method === "skills.proposals.list"),
      ).toHaveLength(1);
      expect(page.state?.skillWorkshopRevisionDraft).toBe(instructions);
      expect(page.state?.skillWorkshopError).toContain("Revision admission failed");
      response.resolve(manifest());
      await settleLitElement(page);
      expect(page.querySelector<HTMLTextAreaElement>(".sw-revision-dialog__input")?.value).toBe(
        instructions,
      );
      expect(
        request.mock.calls.filter(([method]) => method === "skills.proposals.list"),
      ).toHaveLength(1);
    } finally {
      response.resolve(manifest());
      page.remove();
      skillWorkshopRevisionAdmissionsFor(context).dispose();
    }
  });

  it.each(["created", "stale"] as const)(
    "shows a %s proposal change on the first warm return to Workshop",
    async (change) => {
      const refreshing = createDeferred();
      const response = createDeferred<ReturnType<typeof manifest>>();
      let refreshingRoute = false;
      const request = vi.fn(async (method: string) => {
        if (method === "skills.proposals.list") {
          if (!refreshingRoute) {
            return change === "created"
              ? { ...manifest(), proposals: [], installedSkills: [] }
              : manifest();
          }
          refreshing.resolve();
          return response.promise;
        }
        if (method === "skills.proposals.inspect") {
          return inspectResult(change === "stale" && refreshingRoute ? "stale" : "pending");
        }
        return {};
      });
      const context = createContext(request, {
        methods: ["skills.proposals.list", "skills.proposals.inspect", "skills.proposals.apply"],
      });
      const router = createRouter({
        routes: [
          skillWorkshopRoute,
          { id: "other", path: "/other", component: () => ({ render: () => html`` }) },
        ],
      });
      const host = document.createElement("openclaw-router-outlet") as LitElement & {
        router: typeof router;
        retryContext: ApplicationContext;
      };
      host.router = router;
      host.retryContext = context;
      const contextProvider = new ContextProvider(host, { context: applicationContext });
      contextProvider.setValue(context);
      document.body.append(host);
      try {
        await router.navigate("skill-workshop", context);
        await settleLitElement(host);
        const initial = host.querySelector<SkillWorkshopPageTestElement>(
          "openclaw-skill-workshop-page",
        )!;
        await settleLitElement(initial);
        expect(initial.querySelectorAll(".sw-row")).toHaveLength(change === "created" ? 0 : 1);
        await router.navigate("other", context);
        await settleLitElement(host);
        const initialLists = request.mock.calls.filter(
          ([method]) => method === "skills.proposals.list",
        ).length;
        refreshingRoute = true;
        const returning = router.navigate("skill-workshop", context);
        await refreshing.promise;
        await settleLitElement(host);
        const cached = host.querySelector<SkillWorkshopPageTestElement>(
          "openclaw-skill-workshop-page",
        );
        if (cached) {
          await settleLitElement(cached);
        }
        response.resolve(manifest(change === "stale" ? "stale" : "pending"));
        await returning;
        await settleLitElement(host);
        const current = host.querySelector<SkillWorkshopPageTestElement>(
          "openclaw-skill-workshop-page",
        )!;
        await settleLitElement(current);
        expect(
          request.mock.calls.filter(([method]) => method === "skills.proposals.list"),
        ).toHaveLength(initialLists + 1);
        expect(current.querySelectorAll(".sw-row")).toHaveLength(change === "created" ? 1 : 0);
        expect(current.querySelector(".sw-action-bar .sw-btn--primary") !== null).toBe(
          change === "created",
        );
      } finally {
        response.resolve(manifest());
        host.remove();
        router.stop();
      }
    },
  );
});
