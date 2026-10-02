import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

export type SidebarExpansionMode = "collapsed-by-user" | "expanded" | "expanded-fully";

/** Parent disclosure state: explicit choices plus the child identities each parent last showed. */
export class SidebarChildExpansion {
  private readonly modes = new Map<string, SidebarExpansionMode>();
  private readonly observedChildKeys = new Map<string, readonly string[]>();
  private restoredPending = false;

  constructor(private readonly onChange: () => void) {}

  /** Opens a projection pass; a scope change drops state unless a snapshot handoff is pending. */
  beginPass(scopeChanged: boolean): void {
    if (scopeChanged && !this.restoredPending) {
      this.modes.clear();
      this.observedChildKeys.clear();
    }
    this.restoredPending = false;
  }

  keys(): string[] {
    return [...this.modes.keys(), ...this.observedChildKeys.keys()];
  }

  observe(session: SidebarRecentSession, listLoaded: boolean): void {
    const previousChildren = this.observedChildKeys.get(session.key);
    const mode = this.modes.get(session.key);
    // New children reveal their parent once; ordinary refreshes and reordering
    // must not undo an explicit collapse or the operator's Show more choice.
    const hasNewChild =
      previousChildren !== undefined &&
      session.childSessionKeys.some((key) => !previousChildren.includes(key));
    if (
      (mode === undefined && session.containsActiveDescendant) ||
      (hasNewChild && mode !== "expanded-fully")
    ) {
      this.modes.set(session.key, "expanded");
    }
    // A route placeholder's empty child list means unknown, not childless; as a
    // baseline it would make every existing child look new once the list loads.
    if (listLoaded) {
      this.observedChildKeys.set(session.key, session.childSessionKeys);
    }
  }

  delete(key: string): void {
    this.modes.delete(key);
    this.observedChildKeys.delete(key);
  }

  isExpanded(key: string): boolean {
    const mode = this.modes.get(key);
    return mode === "expanded" || mode === "expanded-fully";
  }

  isFullyShown(key: string): boolean {
    return this.modes.get(key) === "expanded-fully";
  }

  capture(key: string): SidebarExpansionMode | undefined {
    return this.modes.get(key);
  }

  restore(rows: readonly { key: string; childrenDisplayMode?: SidebarExpansionMode }[]): void {
    this.modes.clear();
    this.observedChildKeys.clear();
    for (const row of rows) {
      if (row.childrenDisplayMode !== undefined) {
        this.modes.set(row.key, row.childrenDisplayMode);
      }
    }
    // The first authoritative projection changes the connection scope; these
    // admitted modes belong to that handoff, not the preceding empty projection.
    this.restoredPending = this.modes.size > 0;
    this.onChange();
  }

  toggle(key: string): { expanded: boolean } {
    this.onChange();
    if (this.isExpanded(key)) {
      // The explicit closed mode prevents a still-active descendant from
      // immediately undoing the user's collapse on the next update pass.
      this.modes.set(key, "collapsed-by-user");
      return { expanded: false };
    }
    this.modes.set(key, "expanded");
    return { expanded: true };
  }

  showMore(key: string): void {
    if (this.isExpanded(key)) {
      this.modes.set(key, "expanded-fully");
      this.onChange();
    }
  }
}
