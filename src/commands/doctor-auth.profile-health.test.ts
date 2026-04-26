import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const authProfileMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(() => {
    throw new Error("unexpected auth profile load");
  }),
  loadAuthProfileStoreForRuntime: vi.fn((_agentDir?: string): AuthProfileStore => {
    throw new Error("unexpected auth profile load");
  }),
  hasDirectAuthProfileStoreSource: vi.fn(() => false),
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
  resolveApiKeyForProfile: vi.fn(),
  resolveProfileUnusableUntilForDisplay: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: authProfileMocks.ensureAuthProfileStore,
  loadAuthProfileStoreForRuntime: authProfileMocks.loadAuthProfileStoreForRuntime,
  hasDirectAuthProfileStoreSource: authProfileMocks.hasDirectAuthProfileStoreSource,
  hasAnyAuthProfileStoreSource: authProfileMocks.hasAnyAuthProfileStoreSource,
  resolveApiKeyForProfile: authProfileMocks.resolveApiKeyForProfile,
  resolveProfileUnusableUntilForDisplay: authProfileMocks.resolveProfileUnusableUntilForDisplay,
}));

const agentScopeMocks = vi.hoisted(() => ({
  listAgentIds: vi.fn(() => ["main"]),
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentDir: vi.fn((_: OpenClawConfig, agentId: string) => `/tmp/agents/${agentId}/agent`),
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: agentScopeMocks.listAgentIds,
  resolveDefaultAgentId: agentScopeMocks.resolveDefaultAgentId,
  resolveAgentDir: agentScopeMocks.resolveAgentDir,
}));

vi.mock("../agents/auth-profiles/doctor.js", () => ({
  formatAuthDoctorHint: vi.fn(async () => ""),
}));

vi.mock("./provider-auth-guidance.js", () => ({
  buildProviderAuthRecoveryHint: vi.fn(() => "Run `openclaw configure`."),
}));

const noteMock = vi.hoisted(() => vi.fn());

vi.mock("../terminal/note.js", () => ({ note: noteMock }));

import { noteAuthProfileHealth } from "./doctor-auth.js";

describe("noteAuthProfileHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentScopeMocks.listAgentIds.mockReturnValue(["main"]);
    agentScopeMocks.resolveDefaultAgentId.mockReturnValue("main");
    agentScopeMocks.resolveAgentDir.mockImplementation(
      (_: OpenClawConfig, agentId: string) => `/tmp/agents/${agentId}/agent`,
    );
    authProfileMocks.ensureAuthProfileStore.mockImplementation(() => {
      throw new Error("unexpected auth profile load");
    });
    authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation(
      (_agentDir?: string): AuthProfileStore => {
        throw new Error("unexpected auth profile load");
      },
    );
    authProfileMocks.hasDirectAuthProfileStoreSource.mockReturnValue(false);
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(false);
  });

  it("skips external auth profile resolution when no auth source exists", async () => {
    await noteAuthProfileHealth({
      cfg: { channels: { telegram: { enabled: true } } } as OpenClawConfig,
      prompter: {} as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.hasAnyAuthProfileStoreSource).toHaveBeenCalledOnce();
    expect(authProfileMocks.ensureAuthProfileStore).not.toHaveBeenCalled();
  });

  it("labels auth warnings with the agent when multiple agent stores diverge", async () => {
    agentScopeMocks.listAgentIds.mockReturnValue(["main", "coder"]);
    authProfileMocks.hasDirectAuthProfileStoreSource.mockImplementation(
      (agentDir?: string) => agentDir === undefined || agentDir.includes("coder"),
    );
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.loadAuthProfileStoreForRuntime.mockImplementation((agentDir?: string) => ({
      version: 1,
      profiles: {
        "openai-codex:user@example.com": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: agentDir?.includes("coder") ? Date.now() + 10 * 24 * 60 * 60 * 1000 : 1,
        },
      },
    }));
    const confirmAutoFix = vi.fn(async () => true);

    await noteAuthProfileHealth({
      cfg: { agents: { list: [{ id: "main" }, { id: "coder" }] } } as OpenClawConfig,
      prompter: { confirmAutoFix } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(confirmAutoFix).not.toHaveBeenCalled();
    expect(authProfileMocks.resolveApiKeyForProfile).not.toHaveBeenCalled();
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("- openai-codex:user@example.com: expired"),
      "Model auth (agent: main)",
    );
    expect(noteMock).not.toHaveBeenCalledWith(expect.any(String), "Model auth");
  });

  it("does not duplicate inherited-only auth stores across agents", async () => {
    agentScopeMocks.listAgentIds.mockReturnValue(["main", "coder"]);
    authProfileMocks.hasDirectAuthProfileStoreSource.mockImplementation(
      (agentDir?: string) => agentDir === undefined,
    );
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue({ version: 1, profiles: {} });

    await noteAuthProfileHealth({
      cfg: { agents: { list: [{ id: "main" }, { id: "coder" }] } } as OpenClawConfig,
      prompter: { confirmAutoFix: vi.fn(async () => false) } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledOnce();
    expect(authProfileMocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
  });

  it("keeps the runtime-default store when non-default agents also have auth stores", async () => {
    agentScopeMocks.listAgentIds.mockReturnValue(["main", "coder"]);
    authProfileMocks.hasDirectAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.hasAnyAuthProfileStoreSource.mockReturnValue(true);
    authProfileMocks.loadAuthProfileStoreForRuntime.mockReturnValue({ version: 1, profiles: {} });

    await noteAuthProfileHealth({
      cfg: { agents: { list: [{ id: "main" }, { id: "coder" }] } } as OpenClawConfig,
      prompter: { confirmAutoFix: vi.fn(async () => false) } as unknown as DoctorPrompter,
      allowKeychainPrompt: false,
    });

    expect(authProfileMocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(undefined, {
      readOnly: true,
      allowKeychainPrompt: false,
    });
    expect(authProfileMocks.loadAuthProfileStoreForRuntime).toHaveBeenCalledWith(
      "/tmp/agents/coder/agent",
      {
        readOnly: true,
        allowKeychainPrompt: false,
      },
    );
  });
});
