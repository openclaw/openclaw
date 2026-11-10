import type { SidebarSessionSection } from "../lib/sessions/grouping.ts";

/** Keep a newly created group visible without changing the personal filter. */
export function includeSidebarSessionSection(
  section: SidebarSessionSection<unknown>,
  hideEmptyGroups: boolean,
  revealedCreatedGroup?: string | null,
): boolean {
  return (
    section.id !== "pinned" &&
    !(
      hideEmptyGroups &&
      !section.id.startsWith("catalog:") &&
      section.rows.length === 0 &&
      (!revealedCreatedGroup || section.id !== `category:${revealedCreatedGroup}`)
    )
  );
}
