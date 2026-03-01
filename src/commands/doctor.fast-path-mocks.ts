import { vi } from "vitest";

vi.mock("./doctor-completion.js", () => ({
  doctorShellCompletion: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-gateway-daemon-flow.js", () => ({
  maybeRepairGatewayDaemon: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-gateway-health.js", () => ({
  checkGatewayHealth: vi.fn().mockResolvedValue({ healthOk: false }),
  probeGatewayMemoryStatus: vi.fn().mockResolvedValue({ checked: false, ready: false }),
}));

vi.mock("./doctor-memory-search.js", () => ({
  noteMemorySearchHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-platform-notes.js", () => ({
  noteDeprecatedLegacyEnvVars: vi.fn(),
  noteMacLaunchAgentOverrides: vi.fn().mockResolvedValue(undefined),
  noteMacLaunchctlGatewayEnvOverrides: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-sandbox.js", () => ({
  maybeRepairSandboxImages: vi.fn(async (cfg: unknown) => cfg),
  noteSandboxScopeWarnings: vi.fn(),
}));

vi.mock("./doctor-security.js", () => ({
  noteSecurityWarnings: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-session-locks.js", () => ({
  noteSessionLockHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-state-integrity.js", () => ({
  noteStateIntegrity: vi.fn().mockResolvedValue(undefined),
  noteWorkspaceBackupTip: vi.fn(),
}));

vi.mock("./doctor-ui.js", () => ({
  maybeRepairUiProtocolFreshness: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./doctor-workspace-status.js", () => ({
  noteWorkspaceStatus: vi.fn(),
}));
