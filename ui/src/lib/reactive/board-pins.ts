import type { BoardProvider } from "../board/provider.ts";
import type { BoardSnapshot } from "../board/types.ts";
import { createSharedOwnerProjection } from "./shared-owner-projection.ts";

const namesBySnapshot = new WeakMap<BoardSnapshot, ReadonlySet<string>>();

/** BoardProvider publishes fresh snapshots; prepare membership once while reads stay synchronous. */
export const projectBoardWidgetNames = createSharedOwnerProjection(
  (source: BoardProvider["snapshot$"]) => {
    const snapshot = source.value;
    let names = namesBySnapshot.get(snapshot);
    if (!names) {
      names = new Set(snapshot.widgets.map((widget) => widget.name));
      namesBySnapshot.set(snapshot, names);
    }
    return names;
  },
);
