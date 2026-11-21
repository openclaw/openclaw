import type { RouteLocation } from "@openclaw/uirouter";
import { createMemo, createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import {
  isInstalledSkillsPath,
  pathForClawHubSkill,
  pathForInstalledSkill,
  pathForInstalledSkills,
  pathForRoute,
  type SkillPageRef,
} from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { skillPageForLocation, skillsRouteLocation } from "./route-location.ts";

type Surface = "discovery" | "settings";

/** Which skill page the address names, and the ways to open and leave one. */
function createSkillPageRoute(options: {
  context: ApplicationContext;
  surface: () => Surface;
  scope: () => { agentId: string | null };
}) {
  const { context } = options;
  const [location, setLocation] = createSignal<RouteLocation>(context.router.getState().location);
  // Search and hash changes keep the page value when the address still names the same skill.
  const page = createMemo(() => skillPageForLocation(location(), context.basePath), {
    equals: (left, right) =>
      left === right ||
      (left?.kind === "installed" &&
        right?.kind === "installed" &&
        left.skillKey === right.skillKey) ||
      (left?.kind === "clawhub" && right?.kind === "clawhub" && left.ref === right.ref),
  });
  const installed = createMemo(() => {
    const current = skillsRouteLocation(location());
    return (
      options.surface() === "discovery" &&
      (isInstalledSkillsPath(current.pathname, context.basePath) ||
        (page()?.kind === "installed" &&
          new URLSearchParams(current.search).get("from") === "installed"))
    );
  });
  const listRoute = (): "skills" | "skill-settings" =>
    options.surface() === "discovery" ? "skills" : "skill-settings";
  const agentSearch = (route: ReturnType<typeof listRoute>) => {
    const explicit = new URLSearchParams(skillsRouteLocation(location()).search).get("agent");
    const agentId = options.scope().agentId ?? explicit;
    const defaultId = context.agents.state.agentsList?.defaultId;
    // Keep copied links scoped to an explicitly selected agent or to a different surface.
    return agentId && (explicit !== null || route !== listRoute() || agentId !== defaultId)
      ? `?agent=${encodeURIComponent(agentId)}`
      : "";
  };
  return {
    page,
    installed,
    setLocation,
    browseHref: () => `${pathForRoute("skills", context.basePath)}${agentSearch("skills")}`,
    listHref: () =>
      `${installed() ? pathForInstalledSkills(context.basePath) : pathForRoute(listRoute(), context.basePath)}${agentSearch(listRoute())}`,
    openInventory(this: void) {
      context.navigate("skills", {
        pathname: pathForInstalledSkills(context.basePath),
        search: agentSearch("skills"),
      });
    },
    openInstalled(this: void, skillKey: string) {
      const search = new URLSearchParams(agentSearch(listRoute()));
      if (installed()) {
        search.set("from", "installed");
      }
      context.navigate(listRoute(), {
        pathname: pathForInstalledSkill(skillKey, options.surface(), context.basePath),
        search: search.size ? `?${search}` : "",
      });
    },
    openClawHub(this: void, ref: string) {
      context.navigate("skills", {
        pathname: pathForClawHubSkill(ref, context.basePath),
        search: agentSearch("skills"),
      });
    },
    close(this: void) {
      context.navigate(listRoute(), {
        ...(installed() ? { pathname: pathForInstalledSkills(context.basePath) } : {}),
        search: agentSearch(listRoute()),
      });
    },
    /** Either Skills list, for the same agent. */
    navigateList(route: "skills" | "skill-settings") {
      context.navigate(route, { search: agentSearch(route) });
    },
  };
}

/**
 * A skill's page reads what it shows on its own: the card for an installed skill, the registry
 * detail for a ClawHub skill. Each read is scoped to the connection, agent and revision.
 */
function createSkillPageReads(options: {
  page: () => SkillPageRef | null;
  scope: () => {
    client: GatewayBrowserClient | null;
    epoch: number;
    agentId: string | null;
    agentRevision: number;
  };
  cardSkill: (skillKey: string) => SkillStatusEntry | undefined;
  openedKey: () => string | null;
  openInstalled: (skillKey: string | null) => void;
  loadCard: (skillKey: string) => void;
  clawhubRef: () => string | null;
  openClawHub: (ref: string) => void;
  closeClawHub: () => void;
}) {
  let cardScope = "";
  let clawhubScope = "";
  const readSnapshot = () => {
    const page = options.page();
    return {
      page,
      ...options.scope(),
      openedKey: options.openedKey(),
      clawhubRef: options.clawhubRef(),
      skill: page?.kind === "installed" ? options.cardSkill(page.skillKey) : undefined,
    };
  };
  const synchronizeReads = (
    current: ReturnType<typeof readSnapshot>,
    previous: ReturnType<typeof readSnapshot> | undefined,
  ) => {
    const scope = `${current.epoch}\u0000${current.agentId ?? ""}\u0000${current.agentRevision}`;
    const page = current.page;
    const skillKey = page?.kind === "installed" ? page.skillKey : null;
    if (current.openedKey !== skillKey) {
      options.openInstalled(skillKey);
    }
    const cardRequest =
      skillKey && current.skill?.skillCard?.present ? `${skillKey}\u0000${scope}` : "";
    // An accepted report can invalidate the cached card on the same page and agent.
    if (
      skillKey &&
      cardRequest &&
      current.client &&
      (cardRequest !== cardScope || current.skill !== previous?.skill)
    ) {
      options.loadCard(skillKey);
    }
    cardScope = cardRequest;
    const ref = page?.kind === "clawhub" ? page.ref : null;
    if (!ref) {
      clawhubScope = "";
      if (current.clawhubRef) {
        options.closeClawHub();
      }
      return;
    }
    const detailRequest = `${ref}\u0000${scope}`;
    if (current.client && current.agentId && detailRequest !== clawhubScope) {
      clawhubScope = detailRequest;
      options.openClawHub(ref);
    }
  };
  return {
    readSnapshot,
    synchronizeReads,
    /** The open page reads again once its scope settles, for a new agent or connection. */
    reset() {
      cardScope = "";
      clawhubScope = "";
    },
  };
}

/** The skill pages of one Skills surface: the address, the reads, and the open installed key. */
export function createSkillPages(options: {
  context: ApplicationContext;
  surface: () => Surface;
  scope: () => {
    client: GatewayBrowserClient | null;
    epoch: number;
    agentId: string | null;
    agentRevision: number;
  };
  report: () => SkillStatusReport | null | undefined;
  openedKey: () => string | null;
  setOpenedKey: (skillKey: string | null) => void;
  loadCard: (skillKey: string) => void;
  clawhubRef: () => string | null;
  openClawHub: (ref: string) => void;
  closeClawHub: () => void;
}) {
  const route = createSkillPageRoute(options);
  const reads = createSkillPageReads({
    ...options,
    page: route.page,
    cardSkill: (skillKey) => options.report()?.skills.find((skill) => skill.skillKey === skillKey),
    openInstalled: (skillKey) => {
      options.setOpenedKey(skillKey);
      if (skillKey) {
        // The page needs the stored API key's source; read config only once one opens.
        void options.context.runtimeConfig.ensureDisplayLoaded();
      }
    },
  });
  return { ...route, ...reads };
}
