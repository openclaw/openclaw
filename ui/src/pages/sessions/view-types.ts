import type { SessionsPageOwner } from "./sessions-page-state.ts";

type View = ReturnType<SessionsPageOwner["view"]>;
type OptionalFields =
  | "labelDisabledReason"
  | "patchAdminDisabledReason"
  | "groupWriteDisabledReason"
  | "deleteArchivedDisabledReason"
  | "deleteSelectedDisabledReason";

type Command = "onDeleteSelected" | "onDeleteAllArchived" | "onPatch" | "onAssignCategory";
export type SessionsProps = Omit<
  View,
  OptionalFields | "sessionMenu" | "commandEpoch" | Command
> & {
  [Key in Command]: (...args: Parameters<View[Key]>) => Promise<unknown> | void;
} & Partial<Pick<View, OptionalFields>> & {
    sessionMenu: { key: string } | null;
    commandPending?: boolean;
  };
