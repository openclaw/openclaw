/** Complete parent snapshot shared by the churn and background-history scenarios. */
export function swarmSnapshot(
  groupId: string,
  createdAt: number,
  children: { key: string; status?: string | null }[],
) {
  return {
    groups: [
      {
        groupId,
        createdAt,
        queued: 0,
        running: children.filter((child) => child.status === "running").length,
        done: children.filter((child) => child.status === "done").length,
        failed: 0,
        children: children.map((child) => ({
          sessionKey: child.key,
          status: child.status === "done" ? ("done" as const) : ("running" as const),
        })),
      },
    ],
    otherActiveGroups: 0,
  };
}
