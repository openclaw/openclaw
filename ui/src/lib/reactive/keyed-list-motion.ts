import { createMemo, createSignal, onSettled } from "solid-js";
import { createLayoutMeasurement } from "./layout-measurement.ts";
import { createMediaQuery } from "./platform.ts";

const timing = { duration: 150, easing: "cubic-bezier(0.19, 1, 0.22, 1)", delay: 0 };
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** Animate membership changes while the keyed renderer retains nodes and action identity. */
export function createKeyedListMotion(input: {
  ids: () => readonly string[];
  scope: () => unknown;
  active: () => boolean;
  ready: () => boolean;
}) {
  const ids = createMemo(input.ids, { equals: sameIds });
  const reduced = createMediaQuery("(prefers-reduced-motion: reduce)");
  const [retained, setRetained] = createSignal(false);
  const elements = new Map<string, Set<HTMLElement>>();
  const positions = new Map<string, number>();
  const rowAnimations = new Map<string, Animation>();
  let shell: HTMLDivElement | undefined;
  let content: HTMLDivElement | undefined;
  let heightAnimation: Animation | undefined;
  let previousIds: readonly string[] = [];
  let previousScope: unknown;
  let previouslyActive = false;
  let initialized = false;
  let height = 0;
  let generation = 0;
  let disposed = false;
  const cancel = () => {
    generation += 1;
    heightAnimation?.cancel();
    heightAnimation = undefined;
    rowAnimations.forEach((animation) => animation.cancel());
    rowAnimations.clear();
    if (shell) {
      shell.style.overflow = "";
    }
  };

  const schedule = createLayoutMeasurement(
    () => ({
      ids: ids(),
      scope: input.scope(),
      active: input.active(),
      ready: input.ready(),
      reduced: reduced(),
      retained: retained(),
    }),
    (next) => {
      if (!next) {
        return undefined;
      }
      if (!shell?.isConnected || !content?.isConnected) {
        if (next.ready && next.active && next.ids.length === 0) {
          return () => {
            if (disposed) {
              return;
            }
            cancel();
            initialized = true;
            previousIds = next.ids;
            previousScope = next.scope;
            previouslyActive = next.active;
            height = 0;
            positions.clear();
          };
        }
        return undefined;
      }
      const target = shell;
      const reset =
        initialized && (next.scope !== previousScope || next.active !== previouslyActive);
      const changed = !sameIds(next.ids, previousIds);
      const resting = !changed && !reset && !next.reduced;
      if (resting && (heightAnimation || rowAnimations.size > 0)) {
        return undefined;
      }
      // Loading can retain another rendered copy outside this content region.
      const visible = next.ids.map((id) =>
        [...(elements.get(id) ?? [])].find((element) => content!.contains(element)),
      );
      if (visible.some((element) => !element)) {
        return undefined;
      }
      if (
        [...elements].some(
          ([id, candidates]) =>
            !next.ids.includes(id) && [...candidates].some((element) => content!.contains(element)),
        )
      ) {
        return undefined;
      }
      if (
        visible.some(
          (element, index) =>
            index > 0 &&
            !(
              visible[index - 1]!.compareDocumentPosition(element!) &
              Node.DOCUMENT_POSITION_FOLLOWING
            ),
        )
      ) {
        return undefined;
      }
      const origin = target.getBoundingClientRect().top;
      const fromHeight = heightAnimation ? target.getBoundingClientRect().height : height;
      const toHeight = content.getBoundingClientRect().height;
      const rows = next.ids.flatMap((id, index) => {
        const element = visible[index]!;
        const style = getComputedStyle(element);
        const translate =
          style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42;
        const naturalTop = element.getBoundingClientRect().top - origin - translate;
        const previousTop = positions.get(id);
        return [
          {
            id,
            element,
            naturalTop,
            delta: previousTop === undefined ? 0 : previousTop + translate - naturalTop,
            opacity: previousTop === undefined ? 0 : Number(style.opacity),
          },
        ];
      });
      return () => {
        if (disposed || shell !== target) {
          return;
        }
        if (resting) {
          height = toHeight;
          positions.clear();
          for (const row of rows) {
            positions.set(row.id, row.naturalTop);
          }
          return;
        }
        cancel();
        const currentGeneration = generation;
        const animate =
          initialized && next.ready && next.active && !next.reduced && !reset && changed;
        initialized = next.ready;
        previousScope = next.scope;
        previouslyActive = next.active;
        previousIds = next.ids;
        height = toHeight;
        positions.clear();
        for (const row of rows) {
          positions.set(row.id, row.naturalTop);
        }
        setRetained(next.ids.length > 0 || animate);
        if (!animate) {
          return;
        }
        for (const { id, element, delta, opacity } of rows) {
          if (delta === 0 && opacity === 1) {
            continue;
          }
          const animation = element.animate(
            [
              { transform: `translateY(${delta}px)`, opacity },
              { transform: "translateY(0px)", opacity: 1 },
            ],
            timing,
          );
          rowAnimations.set(id, animation);
          animation.onfinish = () => {
            if (generation !== currentGeneration || rowAnimations.get(id) !== animation) {
              return;
            }
            animation.cancel();
            rowAnimations.delete(id);
          };
        }
        if (fromHeight === toHeight) {
          setRetained(next.ids.length > 0);
          return;
        }
        target.style.overflow = "clip";
        const animation = target.animate(
          [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
          { ...timing, fill: "both" },
        );
        heightAnimation = animation;
        animation.onfinish = () => {
          if (generation !== currentGeneration || heightAnimation !== animation) {
            return;
          }
          animation.cancel();
          heightAnimation = undefined;
          target.style.overflow = "";
          setRetained(previousIds.length > 0);
        };
      };
    },
    { targets: () => (content ? [content] : []), measureWithoutTarget: true },
  );
  onSettled(() => () => {
    disposed = true;
    cancel();
  });
  return {
    present: () => ids().length > 0 || retained(),
    shell: (element: HTMLDivElement) => {
      shell = element;
    },
    content: (element: HTMLDivElement) => {
      content = element;
    },
    row: (id: string) => {
      let element: HTMLElement | undefined;
      onSettled(() => () => {
        if (!element) {
          return;
        }
        const candidates = elements.get(id);
        candidates?.delete(element);
        if (candidates?.size === 0) {
          elements.delete(id);
        }
        schedule();
      });
      return (node: HTMLElement) => {
        element = node;
        let candidates = elements.get(id);
        if (!candidates) {
          elements.set(id, (candidates = new Set()));
        }
        candidates.add(node);
        schedule();
      };
    },
  };
}
