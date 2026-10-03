export const approvalsCommandPolicies = [
  { commandPath: ["approvals"], policy: { networkProxy: "bypass" } },
  { commandPath: ["exec-approvals"], policy: { networkProxy: "bypass" } },
  {
    commandPath: ["approvals", "pending"],
    exact: true,
    policy: { configGuard: "skip", loadPlugins: "never", networkProxy: "bypass" },
  },
  ...["approvals", "exec-approvals"].map((primary) => ({
    commandPath: [primary, "reconcile"],
    exact: true,
    // Preview is read-only; explicit retirement owns its maintenance boundary.
    policy: {
      configGuard: "skip",
      loadPlugins: "never",
      ensureCliPath: false,
      networkProxy: "bypass",
    } as const,
  })),
] as const;
