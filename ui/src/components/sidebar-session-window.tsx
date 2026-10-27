import { createMemo, createSignal, onSettled, useContext } from "solid-js";
import { createLayoutMeasurement } from "../lib/reactive/layout-measurement.ts";
import { createResizeObserver } from "../lib/reactive/observers.ts";
import type { SessionListHost } from "./app-sidebar-session-render-types.ts";
import { visibleSessionChildren, type SidebarRecentSession } from "./app-sidebar-session-types.ts";
import { SidebarScrollContext } from "./sidebar-context-controller.ts";

type WindowItem = { row: SidebarRecentSession; index: number; top: number; height: number };
type GeometrySignature = [boolean] | [boolean, GeometrySignature[], boolean, string[]];

/** Bounded sidebar pages need only a prefix-height pass. The transcript's
 * general virtualizer stays out of the eager sidebar/New Session graph. */
export function createSidebarSessionWindow(
  rows: () => readonly SidebarRecentSession[],
  host: () => SessionListHost,
  enabled: () => boolean,
) {
  const scroll = useContext(SidebarScrollContext);
  let list: HTMLDivElement;
  const [rowFloor, setRowFloor] = createSignal(30);
  const [focusedKey, setFocusedKey] = createSignal<string>();
  const [view, setView] = createSignal<{ items: WindowItem[]; height: number }>({
    items: [],
    height: 0,
  });
  const retained = (row: SidebarRecentSession, focused: string | undefined): boolean =>
    row.visuallyActive ||
    row.key === focused ||
    host().selectedSessionKeys.has(row.key) ||
    host().sessionOrganizer.draggingSessionKey === row.key ||
    host().sidebarMenus.sessionMenu?.session.key === row.key ||
    row.children.some((child) => retained(child, focused));
  const describe = (
    row: SidebarRecentSession,
  ): { height: number; signature: GeometrySignature } => {
    const preview =
      host().sessionsShowPreview &&
      Boolean(row.snapshotSubtitle?.subtitle || row.lastMessagePreview || row.channelPresentation);
    const ownHeight = Math.max(preview ? 50 : 30, rowFloor());
    if (!host().isSessionChildrenExpanded(row)) {
      return { height: ownHeight, signature: [preview] };
    }
    const children = visibleSessionChildren({
      session: row,
      fullyShown: host().isSessionChildrenFullyShown(row.key),
    }).map(describe);
    const errors = (row.childLoadParentKeys ?? [row.key]).map(
      (key) => host().sessionData.childSessionErrorsByParent.get(key) ?? "",
    );
    return {
      height:
        ownHeight +
        2 +
        children.reduce((height, child) => height + child.height, 0) +
        Math.max(0, children.length - 1) * 2 +
        (children.length < row.children.length ? 30 : 0) +
        (row.loadingChildren && children.length === 0 ? 30 : 0),
      signature: [preview, children.map((child) => child.signature), row.loadingChildren, errors],
    };
  };
  const inputs = createMemo(() => {
    const source = enabled() ? rows() : [];
    const focusedIndex = source.findIndex((row) => row.key === focusedKey());
    return source.map((row, index) => {
      const description = describe(row);
      return {
        row,
        height: description.height,
        signature: JSON.stringify(description.signature),
        retained:
          retained(row, focusedKey()) || (focusedIndex >= 0 && Math.abs(index - focusedIndex) <= 1),
      };
    });
  });
  if (!scroll) {
    return {
      bind: (element: HTMLDivElement) => (list = element),
      rows,
      height: () => undefined,
      item: (_key: string) => undefined,
      focus: (_key: string) => {},
      rowRef: (_key: () => string) => (_element: HTMLDivElement) => {},
    };
  }
  const measured = new Map<string, { signature: string; height: number }>();
  const mounted = new Map<string, HTMLDivElement>();
  const [mountRevision, setMountRevision] = createSignal(0);
  let current: ReturnType<typeof inputs> = [];
  let positions: WindowItem[] = [];
  let totalHeight = 0;
  let viewportHeight = 0;
  let margin = 0;
  let layout = "";
  let restored = false;
  // Initial list sizing can clamp scrollTop before its logical anchor is restored.
  const restoreAnchor = scroll.readAnchor();
  const anchorAt = (top: number) =>
    top < 0 || top >= totalHeight ? undefined : positions.findLast((item) => item.top <= top);
  const publish = () => {
    const scroller = scroll.element();
    if (!scroller) {
      return;
    }
    const top = scroller.scrollTop - margin;
    const first = positions.findIndex((item) => item.top + item.height > top);
    const beyond = positions.findIndex((item) => item.top >= top + viewportHeight);
    const start = first < 0 ? positions.length : Math.max(0, first - 2);
    const end = beyond < 0 ? positions.length : Math.min(positions.length, beyond + 2);
    const items = positions.filter(
      (_, index) => (index >= start && index < end) || current[index]!.retained,
    );
    setView((previous) =>
      previous.height === totalHeight &&
      previous.items.length === items.length &&
      previous.items.every(
        (item, index) =>
          item.row === items[index]!.row &&
          item.top === items[index]!.top &&
          item.height === items[index]!.height &&
          item.index === items[index]!.index,
      )
        ? previous
        : { items, height: totalHeight },
    );
  };
  const rebuild = () => {
    const scroller = scroll.element();
    const anchor = scroller && anchorAt(scroller.scrollTop - margin);
    const offset = anchor && scroller ? scroller.scrollTop - margin - anchor.top : 0;
    let top = 0;
    positions = current.map((input, index) => {
      const known = measured.get(input.row.key);
      const height = known?.signature === input.signature ? known.height : input.height;
      const item = { row: input.row, index, top, height };
      top += height + 2;
      return item;
    });
    totalHeight = Math.max(0, top - 2);
    const next = anchor && positions.find((item) => item.row.key === anchor.row.key);
    if (scroller && next && next.top !== anchor?.top) {
      scroller.scrollTop = margin + next.top + offset;
    }
    publish();
  };
  const scheduleMeasurement = createLayoutMeasurement(
    () => ({ items: inputs() }),
    (request) => {
      const scroller = scroll.element();
      if (!request || !scroller) {
        return undefined;
      }
      const style = getComputedStyle(scroller);
      // Unstyled hosts retain the estimate until CSS supplies the row minimum.
      const nextRowFloor =
        Number.parseFloat(style.getPropertyValue("--sidebar-session-row-floor")) || 30;
      const nextLayout = [
        scroller.clientWidth,
        style.getPropertyValue("--control-ui-text-scale"),
        style.getPropertyValue("--sidebar-session-row-floor"),
        style.getPropertyValue("--sidebar-session-link-padding-block"),
      ].join(":");
      const nextHeight = scroller.clientHeight;
      const nextMargin =
        list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      // All layout reads precede the publication/scroll writes.
      return () => {
        // This request still contains estimates for the previous CSS minimum.
        if (rowFloor() !== nextRowFloor) {
          setRowFloor(nextRowFloor);
          return;
        }
        if (layout !== nextLayout) {
          measured.clear();
        }
        layout = nextLayout;
        viewportHeight = nextHeight;
        margin = nextMargin;
        current = request.items;
        const keys = new Set(current.map((item) => item.row.key));
        for (const key of measured.keys()) {
          if (!keys.has(key)) {
            measured.delete(key);
          }
        }
        rebuild();
        if (!restored && current.length) {
          const restoredItem =
            restoreAnchor && positions.find((item) => item.row.key === restoreAnchor.key);
          if (restoredItem) {
            scroller.scrollTop = margin + restoredItem.top + restoreAnchor!.offset;
          }
          restored = true;
          publish();
        }
      };
    },
    {
      targets: () => [
        list,
        ...(scroll.element() ? [scroll.element()!] : []),
        ...(scroll.content() ? [scroll.content()!] : []),
      ],
    },
  );
  createResizeObserver(
    () => {
      mountRevision();
      return [...mounted.values()];
    },
    (entries) => {
      let changed = false;
      // Resize delivery supplies geometry; never force a layout for each row.
      for (const entry of entries) {
        const key = entry.target.getAttribute("data-session-window-key");
        const input = current.find((item) => item.row.key === key);
        if (!input || !key) {
          continue;
        }
        const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
        const previous = measured.get(key);
        if (height > 0 && (previous?.signature !== input.signature || previous.height !== height)) {
          measured.set(key, { signature: input.signature, height });
          changed = true;
        }
      }
      if (changed) {
        // Publish parent geometry outside the row's ResizeObserver delivery.
        scheduleMeasurement();
      }
    },
  );
  onSettled(() =>
    scroll.subscribeScroll(() => {
      const scroller = scroll.element();
      if (!scroller) {
        return;
      }
      publish();
      const top = scroller.scrollTop - margin;
      const anchor = anchorAt(top);
      if (anchor) {
        scroll.captureAnchor({ key: anchor.row.key, offset: top - anchor.top });
      }
    }),
  );
  const items = createMemo(() => new Map(view().items.map((item) => [item.row.key, item])));
  const fullHeight = createMemo(() => {
    view();
    return Math.max(
      0,
      inputs().reduce((height, input) => {
        const known = measured.get(input.row.key);
        return height + (known?.signature === input.signature ? known.height : input.height) + 2;
      }, -2),
    );
  });
  return {
    bind: (element: HTMLDivElement) => (list = element),
    rows: () => rows().filter((row) => items().has(row.key)),
    height: () => `${fullHeight()}px`,
    item: (key: string) => items().get(key),
    focus: setFocusedKey,
    rowRef(key: () => string) {
      let element: HTMLDivElement;
      onSettled(() => {
        const currentKey = key();
        mounted.set(currentKey, element);
        setMountRevision((value) => value + 1);
        return () => {
          mounted.delete(currentKey);
          setMountRevision((value) => value + 1);
        };
      });
      return (node: HTMLDivElement) => (element = node);
    },
  };
}
