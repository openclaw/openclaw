import type { GatewaySessionRow } from "../api/types.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

/** Slot identities belong to the publishing owners; projection never compares row contents. */
export class SidebarProjectionMemo<T> {
  private slots: readonly unknown[] | undefined;
  private value!: T;

  read(inputs: () => readonly unknown[], project: () => T): T {
    const slots = inputs();
    if (
      !this.slots ||
      slots.length !== this.slots.length ||
      slots.some((slot, index) => !Object.is(slot, this.slots![index]))
    ) {
      this.value = project();
      // Stateful projection may publish created order, membership, or subtitles.
      this.slots = inputs();
    }
    return this.value;
  }
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
