import { createMemo } from "solid-js";
import { pathForRoute } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";

export const skillCatalogSections = ["all", "trending", "installed", "library"] as const;
export type SkillCatalogSection = (typeof skillCatalogSections)[number];
export type SkillCatalogTarget = { kind: "local" | "library" | "remote"; key: string };

const targetParams = { local: "skill", library: "library", remote: "clawhub" } as const;

export function readSkillCatalogLocation(search: string) {
  const params = new URLSearchParams(search);
  const section = skillCatalogSections.find((item) => item === params.get("section")) ?? "all";
  let target: SkillCatalogTarget | null = null;
  for (const kind of ["local", "library", "remote"] as const) {
    const key = params.get(targetParams[kind]);
    if (key) {
      target = { kind, key };
      break;
    }
  }
  return { query: params.get("q") ?? "", section, target };
}

export function skillCatalogLocation(
  basePath: string,
  agentId: string | null,
  query: string,
  section: SkillCatalogSection,
  target?: SkillCatalogTarget,
) {
  const params = new URLSearchParams();
  if (target) params.set(targetParams[target.kind], target.key);
  if (agentId) params.set("agent", agentId);
  if (query) params.set("q", query);
  if (section !== "all") params.set("section", section);
  return { pathname: pathForRoute("skills", basePath), search: params.size ? "?" + params : "" };
}

export function createSkillCatalogNavigation(
  context: ApplicationContext,
  surface: () => "discovery" | "settings",
  selectedAgent: () => string | null,
) {
  const location = projectOwner(
    context.router,
    (router) => router.getState().location.search,
    Object.is,
  );
  const catalog = createMemo(() => readSkillCatalogLocation(location.read()));
  const requestedAgent = createMemo(() => new URLSearchParams(location.read()).get("agent"));
  const catalogTarget = createMemo(() => (surface() === "discovery" ? catalog().target : null), {
    equals: (a, b) => a?.kind === b?.kind && a?.key === b?.key,
  });
  const locationFor = (
    target?: SkillCatalogTarget,
    query = catalog().query,
    section: SkillCatalogSection = catalog().section,
  ) =>
    skillCatalogLocation(
      context.basePath,
      target ? selectedAgent() : requestedAgent(),
      query,
      section,
      target,
    );
  const catalogHref = (target?: SkillCatalogTarget) => {
    const location = locationFor(target);
    return location.pathname + location.search;
  };
  const openCatalogTarget = (target?: SkillCatalogTarget) =>
    context.navigate("skills", locationFor(target));
  return { catalog, requestedAgent, catalogTarget, locationFor, catalogHref, openCatalogTarget };
}
