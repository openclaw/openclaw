import { createMemo, For, Show } from "solid-js";
import { inlineActivitySegments } from "../chat-activity-segments.ts";
import {
  ActivityGroupBody,
  prepareActivityGroup,
  type ActivityGroupContentProps,
  type ActivityState,
} from "./chat-message-activity-view.tsx";

export {
  inlineActivityDisclosureCalls,
  readInlineToolExpansion,
} from "../chat-activity-segments.ts";
export { ToolCardBody } from "./chat-tool-cards.solid.tsx";
export { InlineToolPreview } from "./chat-tool-inline-preview.tsx";

/** The pane admits this complete presentation before subscribing to live output. */
export function InlineActivityGroupContent(
  props: ActivityGroupContentProps & { state: ActivityState },
) {
  const source = createMemo(() => ({
    rootGroups: new Map(props.state.cardGroups.map((group) => [group.card, group])),
    toolCardOverrides: props.state.toolCardOverrides,
    currentRunActivity: props.state.currentRunActivity,
  }));
  const segments = createMemo(() => inlineActivitySegments(props.groups, source().rootGroups));
  return (
    <For each={segments()} keyed={(segment) => segment.key}>
      {(segment) => {
        const prepared = createMemo(() =>
          prepareActivityGroup(segment().groups, props.options, source()),
        );
        return (
          <Show when={prepared()}>
            {(activity) => (
              <ActivityGroupBody
                {...props}
                groups={segment().groups}
                state={activity()}
                inline={segment().inline}
                liveBubble={
                  props.groups.some(
                    (group) => group.key === props.options.bubbleActivityGroupKey,
                  ) &&
                  props.state.headline !== undefined &&
                  activity().headline?.key === props.state.headline?.key
                }
                segmented
              />
            )}
          </Show>
        );
      }}
    </For>
  );
}
