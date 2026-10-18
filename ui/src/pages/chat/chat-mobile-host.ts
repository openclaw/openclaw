import type { JSX } from "@solidjs/web";
import type { ShellViewportSnapshot } from "../../app/shell-viewport.ts";
import type { SidebarSlotId } from "./sidebar-layout.ts";

export type MobileDetailsRoute =
  | {
      kind:
        | "task-progress"
        | "context"
        | "pull-requests"
        | "goal"
        | "publication"
        | "versions"
        | "people"
        | "sharing"
        | "session-access"
        | "outputs"
        | "automations";
    }
  | { kind: "pull-request"; id: string }
  | { kind: "automation" | "automation-transcript"; id: string };

/** Controlled leaves supply content; the pane alone owns navigation and presentation. */
export type MobileHostDestination = {
  area: "details" | "panels";
  /** Menu actions are dismissed instead of becoming the next panel reveal target. */
  transient?: boolean;
  slot?: SidebarSlotId;
  page?: {
    key: string;
    title: string;
    content?: JSX.Element;
    render?: () => JSX.Element;
    heading?: () => JSX.Element;
    headerActions?: JSX.Element;
    presentation?: "sheet";
    resizable?: boolean;
    details?: MobileDetailsRoute;
    /** False disables expansion controls without changing retained geometry or ancestry. */
    expandable?: boolean;
  };
  /** Explicit ancestry, including entries originating outside Details. */
  backTo?: MobileHostDestination;
};

export type ChatMobileHost = {
  /** Existing connection, agent and session identity from the pane owner. */
  scopeKey: string;
  open: boolean;
  suspended: boolean;
  mode: "dock" | "expanded";
  height: number | undefined;
  reservedHeight: number;
  destination: MobileHostDestination;
  detailsMount: HTMLElement | null;
  setDetailsMount: (element: HTMLElement | null) => void;
  navigate: (destination: MobileHostDestination, source?: HTMLElement) => void;
  reveal: (source?: HTMLElement) => void;
  close: () => void;
  back: () => void;
  toggleExpanded: (visibleDockHeight: number) => void;
  resize: (height: number, mode?: "dock" | "expanded", reservedHeight?: number) => void;
  /** Undefined means the viewport owner has not observed a value. */
  keyboardVisible: boolean | undefined;
  onComposerEditingChange: (editing: boolean) => void;
  onViewportChange: (viewport: ShellViewportSnapshot | undefined) => void;
};
