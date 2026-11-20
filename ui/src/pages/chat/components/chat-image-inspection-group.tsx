import { createMemo, For, Show } from "solid-js";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { prepareGroupedMessage } from "./chat-message-bubble-presentation.ts";
import { ToolMessage } from "./chat-message-bubble-tools.tsx";
import { ExpandedToolCardContent } from "./chat-message-deferred.tsx";
import {
  resolveFileLinkOwnerOptions,
  type NativeMessageGroupOptions,
} from "./chat-message-group-options.ts";
import { ToolMessageSummary } from "./chat-tool-card-row.solid.tsx";

/** Keep each inspection's original media slots, permissions and details behind one disclosure. */
export function ImageInspectionGroup(props: {
  groups: readonly MessageGroup[];
  options: NativeMessageGroupOptions;
}) {
  const inspections = createMemo(() =>
    props.groups.flatMap((group) =>
      group.messages.map((entry) => {
        const entryId = persistedMessageEntryId(entry.message) ?? undefined;
        const options = {
          ...resolveFileLinkOwnerOptions(group, props.options, entryId),
          entryId,
          isStreaming: false,
        };
        return {
          key: entry.key,
          options,
          state: prepareGroupedMessage(
            prepareChatMessageRender(entry.message),
            entry.key,
            options,
            options.onOpenSidebar,
          ),
        };
      }),
    ),
  );
  const first = () => inspections()[0]!;
  const expanded = () => first().state.toolMessageExpanded;
  return (
    <div
      class={["chat-tool-msg-collapse chat-tool-msg-collapse--manual", { "is-open": expanded() }]}
    >
      <ToolMessageSummary
        state={first().state}
        options={first().options}
        imageCount={inspections().reduce((count, item) => count + item.state.images.length, 0)}
      />
      <Show when={expanded()}>
        <div class="row chat-inspection chat-img">
          <For each={inspections()} keyed={(item) => item.key}>
            {(item) => (
              <ToolMessage
                messageKey={item().key}
                state={() => ({ ...item().state, toolMessageExpanded: true })}
                options={item().options}
                hideSummary
                renderContents={() => (
                  <ExpandedToolCardContent
                    card={item().state.singleToolCard!}
                    options={item().state.toolRenderOptions}
                  />
                )}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
