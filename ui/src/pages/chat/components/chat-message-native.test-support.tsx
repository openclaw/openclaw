import { createSignal, getOwner } from "solid-js";
import { mountSolid, type MountSolidOptions } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";
import {
  ActivityGroup,
  MessageGroup,
  type NativeMessageGroupOptions,
} from "./chat-message-group-view.tsx";

export function createGroupedMessageHarness(container: HTMLElement) {
  type Props = Parameters<typeof GroupedMessage>[0];
  let root: ReturnType<typeof mountSolid> | undefined;
  let update: (props: Props) => void;
  return {
    render(
      preparation: Props["preparation"],
      messageKey: string,
      options: Props["options"],
      onOpenSidebar?: Props["onOpenSidebar"],
    ) {
      const next = { preparation, messageKey, options, onOpenSidebar };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [props, setProps] = createSignal<Props>(next, { ownedWrite: true });
            update = setProps;
            return <GroupedMessage {...props()} />;
          },
          { container },
        );
      }
      if (!getOwner()) {
        flush();
      }
    },
    unmount() {
      root?.unmount();
      root = undefined;
    },
  };
}

export function createActivityGroupHarness(container: HTMLElement) {
  type Props = Parameters<typeof ActivityGroup>[0];
  let root: ReturnType<typeof mountSolid> | undefined;
  let update: (props: Props) => void;
  return {
    render(
      groups: Props["groups"],
      options: Props["options"],
      presentation: Props["presentation"] = "standalone",
    ) {
      const next = { groups, options, presentation };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [props, setProps] = createSignal<Props>(next, { ownedWrite: true });
            update = setProps;
            return <ActivityGroup {...props()} />;
          },
          { container },
        );
      }
      if (!getOwner()) {
        flush();
      }
    },
    unmount() {
      root?.unmount();
      root = undefined;
    },
  };
}

export function createMessageGroupHarness(
  container: HTMLElement,
  options: Omit<MountSolidOptions, "container"> = {},
) {
  type Props = Parameters<typeof MessageGroup>[0];
  let root: ReturnType<typeof mountSolid> | undefined;
  let update: (props: Props) => void;
  return {
    render(group: Props["group"], renderOptions: NativeMessageGroupOptions) {
      const next = { group, options: renderOptions };
      if (root) {
        update(next);
      } else {
        root = mountSolid(
          () => {
            const [props, setProps] = createSignal(next);
            update = setProps;
            return <MessageGroup group={props().group} options={props().options} />;
          },
          { ...options, container },
        );
      }
      if (!getOwner()) {
        flush();
      }
    },
    unmount() {
      root?.unmount();
      root = undefined;
    },
  };
}
