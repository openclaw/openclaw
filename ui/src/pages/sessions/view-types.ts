import type { SessionsPageOwner } from "./sessions-page-state.ts";

type View = ReturnType<SessionsPageOwner["view"]>;
type OptionalFields =
  | "labelDisabledReason"
  | "patchAdminDisabledReason"
  | "groupWriteDisabledReason"
  | "deleteArchivedDisabledReason"
  | "deleteSelectedDisabledReason";

export type SessionsProps = Omit<View, OptionalFields | "sessionMenu"> &
  Partial<Pick<View, OptionalFields>> & { sessionMenu: { key: string } | null };
