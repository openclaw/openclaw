import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";

registerNewSessionSetupEnglish();

export function resolveCheckoutChip(params: {
  destination: "local" | "remote" | "cloud";
  worktree: boolean;
  worktreeName: string;
  headBranch?: string;
  baseRef: string;
  repository?: boolean;
}): Readonly<{
  label: string;
}> {
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
