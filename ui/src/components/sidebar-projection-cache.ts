import type { GatewaySessionRow } from "../api/types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** Source identities invalidate derivations; visible revisions can suppress equivalent replacements. */
export class SidebarProjectionMemo<T> {
  private slots: readonly unknown[] | undefined;
  private value!: T;
  private revision = 0;

  readRevision(
    inputs: () => readonly unknown[],
    project: () => T,
    equals: (a: T, b: T) => boolean = Object.is,
  ): number {
    this.read(inputs, project, equals);
    return this.revision;
  }

  read(inputs: () => readonly unknown[], project: () => T, equals?: (a: T, b: T) => boolean): T {
    const slots = inputs();
    if (
      !this.slots ||
      slots.length !== this.slots.length ||
      slots.some((slot, index) => !Object.is(slot, this.slots![index]))
    ) {
      const next = project();
      if (!this.slots || !equals?.(this.value, next)) {
        this.revision += 1;
      }
      // Keep the latest snapshot even when hidden children changed without changing presentation.
      this.value = next;
      // Stateful projection may publish created order, membership, or subtitles.
      this.slots = inputs();
    }
    return this.value;
  }
}

/** Trusted presentation snapshots share unchanged branches; only replacement values are walked. */
export function sameSidebarPresentation(a: unknown, b: unknown, omit?: string): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => sameSidebarPresentation(value ?? null, b[index] ?? null))
    );
  }
  if ((a instanceof Map && b instanceof Map) || (a instanceof Set && b instanceof Set)) {
    if (a.size !== b.size) {
      return false;
    }
    const previous = b.entries();
    for (const [key, value] of a.entries()) {
      const entry = previous.next().value;
      if (!entry || key !== entry[0] || !sameSidebarPresentation(value, entry[1])) {
        return false;
      }
    }
    return true;
  }
  if (a instanceof Map || b instanceof Map || a instanceof Set || b instanceof Set) {
    return false;
  }
  for (const key in a) {
    if (key !== omit && !sameSidebarPresentation(Reflect.get(a, key), Reflect.get(b, key))) {
      return false;
    }
  }
  for (const key in b) {
    if (key !== omit && !(key in a) && Reflect.get(b, key) !== undefined) {
      return false;
    }
  }
  return true;
}

/** Formatting belongs to a row's lifetime, not the lifetime of a list publication. */
export class SidebarSessionRowProjection {
  readonly runtimeSampledAtByRow = new WeakMap<GatewaySessionRow, number>();
  private readonly rows = new WeakMap<
    GatewaySessionRow,
    [SidebarProjectionMemo<SidebarRecentSession>, SidebarProjectionMemo<SidebarRecentSession>]
  >();

  read(
    row: GatewaySessionRow,
    isChild: boolean,
    inputs: readonly unknown[],
    project: () => SidebarRecentSession,
  ): SidebarRecentSession {
    let memos = this.rows.get(row);
    if (!memos) {
      memos = [new SidebarProjectionMemo(), new SidebarProjectionMemo()];
      this.rows.set(row, memos);
    }
    return memos[isChild ? 1 : 0].read(() => inputs, project);
  }
}
