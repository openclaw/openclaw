import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import type { DraftBranches } from "./discovery.ts";

registerNewSessionSetupEnglish();

type CheckoutChipState = Readonly<{
  label: string;
}>;

export function resolveCheckoutChip(params: {
  destination: "local" | "remote" | "cloud";
  worktree: boolean;
  worktreeName: string;
  headBranch?: string;
  baseRef: string;
  repository?: boolean;
}): CheckoutChipState {
  const worktreeName = params.worktreeName.trim();
  if (params.worktree && !params.repository && worktreeName) {
    return { label: t("newSession.checkoutWorktreeNamed", { name: worktreeName }) };
  }
  if (params.destination !== "cloud" && !params.repository && !params.worktree) {
    return { label: params.headBranch || t("newSession.checkoutCurrent") };
  }
  const labels =
    params.destination === "cloud"
      ? (["newSession.checkoutCloud", "newSession.checkoutCloudFrom"] as const)
      : params.repository
        ? (["newSession.checkoutRepository", "newSession.checkoutRepositoryFrom"] as const)
        : (["newSession.checkoutWorktree", "newSession.checkoutWorktreeFrom"] as const);
  return {
    label: params.baseRef ? t(labels[1], { branch: params.baseRef }) : t(labels[0]),
  };
}

export type CheckoutChipOptions = {
  state: CheckoutChipState;
  remotePlacement: boolean;
  repository?: boolean;
  folderLabel: string;
  worktree: boolean;
  worktreeAvailable: boolean;
  repositoryUnavailable?: boolean;
  branches: DraftBranches | null;
  branchesLoading: boolean;
  baseRef: string;
  worktreeName: string;
  submitting: boolean;
  pendingPlacement: boolean;
  popoverOpen: boolean;
  popoverHiding: boolean;
  onGuardTransition: (event: MouseEvent) => void;
  onPopoverShow: () => void;
  onPopoverHide: () => void;
  onPopoverAfterHide: () => void;
  onSelectWorktree: (value: boolean) => void;
  onBaseRefInput: (baseRef: string) => void;
  onWorktreeNameInput: (name: string) => void;
  onConfirm: () => void;
};
