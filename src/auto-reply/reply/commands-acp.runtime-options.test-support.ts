export type AcpRuntimeOptionCommandCase = {
  action: string;
  command: string;
  effectiveOptions: Record<string, unknown>;
  managerMock: "setConfigOptionMock" | "updateSessionRuntimeOptionsMock";
  managerInput: Record<string, unknown>;
  expectedText: string;
};

export function createAcpRuntimeOptionCommandCases(
  sessionKey: string,
): AcpRuntimeOptionCommandCase[] {
  return [
    {
      action: "cwd",
      command: "/acp cwd /tmp/worktree",
      effectiveOptions: { cwd: "/tmp/worktree" },
      managerMock: "updateSessionRuntimeOptionsMock",
      managerInput: { patch: { cwd: "/tmp/worktree" } },
      expectedText: `✅ Updated ACP cwd for ${sessionKey}: /tmp/worktree. Session options: cwd=/tmp/worktree`,
    },
    {
      action: "permissions",
      command: "/acp permissions approve-all",
      effectiveOptions: { permissionProfile: "approve-all" },
      managerMock: "setConfigOptionMock",
      managerInput: { key: "approval_policy", value: "approve-all" },
      expectedText: `✅ Updated ACP permissions profile for ${sessionKey}: approve-all. Session options: permissionProfile=approve-all`,
    },
    {
      action: "timeout",
      command: "/acp timeout 120",
      effectiveOptions: { timeoutSeconds: 120 },
      managerMock: "setConfigOptionMock",
      managerInput: { key: "timeout", value: "120" },
      expectedText: `✅ Updated ACP timeout for ${sessionKey}: 120s. Session options: timeoutSeconds=120`,
    },
    {
      action: "model",
      command: "/acp model openai/gpt-5.4",
      effectiveOptions: { model: "openai/gpt-5.4" },
      managerMock: "setConfigOptionMock",
      managerInput: { key: "model", value: "openai/gpt-5.4" },
      expectedText: `✅ Requested ACP model for ${sessionKey}: openai/gpt-5.4. Session options: model=openai/gpt-5.4`,
    },
  ];
}
