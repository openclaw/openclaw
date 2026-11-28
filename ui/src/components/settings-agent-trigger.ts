import { onSettled } from "solid-js";
import type { AgentSelectElement } from "./agent-select.tsx";

export function createSettingsAgentTrigger(
  readRoster: () => Promise<unknown> | null | undefined,
): NonNullable<AgentSelectElement["triggerAttrs"]> {
  let pending: (() => void) | undefined;
  const cancel = () => {
    pending = undefined;
  };
  return (attrs) => {
    const roster = readRoster();
    if (!roster || !attrs.disabled) {
      return attrs;
    }
    const activate = (trigger: HTMLButtonElement) => {
      if (pending) {
        return;
      }
      const open = () => {
        if (pending !== open) {
          return;
        }
        cancel();
        if (
          trigger.matches(":focus:enabled") &&
          trigger.getAttribute("aria-expanded") === "false"
        ) {
          trigger.click();
        }
      };
      pending = open;
      void roster.then(() => onSettled(open));
    };
    return {
      ...attrs,
      disabled: false,
      onBlur: cancel,
      onClick: (event) => activate(event.currentTarget),
      onKeyDown: (event) => {
        if (event.key === "Escape") {
          cancel();
        } else if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          activate(event.currentTarget);
        }
      },
    };
  };
}
