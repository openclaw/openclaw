import { createMemo, For } from "solid-js";
import { ToastNotice } from "./toast-notice.tsx";
import { TOAST_LANES, type toastOwnerFor, type ToastEntry, type ToastPlacement } from "./toast.ts";

type ToastController = ReturnType<typeof toastOwnerFor>;

export function ToastView(props: {
  toasts: readonly ToastEntry[];
  open: readonly ToastPlacement[];
  owner: ToastController;
}) {
  const anchored = createMemo(() => props.toasts.filter((entry) => entry.lane === "anchored"));
  return (
    <>
      <div class="app-toast-lanes">
        <For each={TOAST_LANES}>
          {(lane) => (
            <ToastStack
              lane={lane}
              entries={props.toasts.filter((entry) => entry.lane === lane)}
              open={props.open.includes(lane)}
              owner={props.owner}
            />
          )}
        </For>
      </div>
      <div
        ref={(element) => props.owner.laneElement("anchored", element)}
        class="app-toast-anchored"
      >
        <For each={anchored()} keyed={(entry) => entry.id}>
          {(entry) => <ToastCard entry={entry()} open={false} owner={props.owner} />}
        </For>
      </div>
    </>
  );
}

/** Newest in front; the next two peek behind it. Hover, focus or a tap opens the
 * stack into a list, and leaving closes it. */
function ToastStack(props: {
  lane: ToastPlacement;
  entries: readonly ToastEntry[];
  open: boolean;
  owner: ToastController;
}) {
  return (
    <div
      ref={(element) => props.owner.laneElement(props.lane, element)}
      class={["app-toast-lane", `app-toast-lane--${props.lane}`]}
      data-open={props.open ? "" : undefined}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          props.owner.hover(props.lane, true);
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== "touch") {
          props.owner.hover(props.lane, false);
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") {
          props.owner.touch(props.lane);
        }
      }}
      onFocusIn={() => props.owner.focus(props.lane, true)}
      onFocusOut={(event) =>
        props.owner.focus(
          props.lane,
          event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget),
        )
      }
    >
      <For each={props.entries} keyed={(entry) => entry.id}>
        {(entry) => <ToastCard entry={entry()} open={props.open} owner={props.owner} />}
      </For>
    </div>
  );
}

function ToastCard(props: { entry: ToastEntry; open: boolean; owner: ToastController }) {
  return (
    <ToastNotice
      toast={props.entry.options}
      lane={props.entry.lane}
      active={props.entry.active}
      depth={props.entry.depth}
      open={props.open}
      onDismiss={(reason) => props.owner.dismiss(props.entry.id, reason)}
      onHover={(hovered) => props.owner.hover("anchored", hovered)}
      onFocus={(focused) => props.owner.focus("anchored", focused)}
      onExit={() => props.owner.transitionEnd(props.entry.id)}
    />
  );
}
