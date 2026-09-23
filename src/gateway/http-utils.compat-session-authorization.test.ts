import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { AuthorizedGatewayHttpRequest } from "./http-auth-utils.js";
import { authorizeOpenAiCompatibleHttpSession } from "./http-utils.js";

const runtime = vi.hoisted(() => ({ cfg: undefined as OpenClawConfig | undefined }));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => runtime.cfg,
}));

afterEach(() => {
  runtime.cfg = undefined;
});

function roleConfig(params: { guestSandbox: "required" | undefined }): OpenClawConfig {
  return {
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "view" },
            agents: ["main"],
            scopes: ["operator.read", "operator.write"],
            ...(params.guestSandbox ? { sandbox: params.guestSandbox } : {}),
          },
          maintainer: {
            sessions: { others: "write" },
            agents: ["main"],
            scopes: ["operator.read", "operator.write", "operator.admin"],
          },
        },
      },
    },
  };
}

function identityRequestAuth(profileId: string): AuthorizedGatewayHttpRequest {
  return {
    trustDeclaredOperatorScopes: false,
    authenticatedUserProfile: {
      profileId,
      displayName: null,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

// Shared-secret bearer callers are attributed to the host-minted system actor,
// exactly as the HTTP auth boundary stamps them.
const OWNER_AUTH: AuthorizedGatewayHttpRequest = {
  trustDeclaredOperatorScopes: false,
  operatorRoleActor: { kind: "system" },
};

describe("authorizeOpenAiCompatibleHttpSession sandbox-required roles", () => {
  it("refuses a fresh session key for a sandbox-required role", async () => {
    await withOpenClawTestState({ label: "compat-sandbox-fresh" }, async () => {
      const cfg = roleConfig({ guestSandbox: "required" });
      runtime.cfg = cfg;
      const profile = ensureProfileForEmail("compat-guest@example.test");
      setUserProfileRole(profile.id, "guest");
      const result = authorizeOpenAiCompatibleHttpSession({
        agentId: "main",
        sessionKey: "agent:main:openai-user:compat-fresh-guest",
        requestAuth: identityRequestAuth(profile.id),
        senderIsOwner: false,
      });
      expect(result).toEqual({
        allowed: false,
        message: expect.stringMatching(/requires a sandboxed session/i),
      });
    });
  });

  it("allows a fresh session key for a role without a sandbox requirement", async () => {
    await withOpenClawTestState({ label: "compat-sandbox-free" }, async () => {
      const cfg = roleConfig({ guestSandbox: undefined });
      runtime.cfg = cfg;
      const profile = ensureProfileForEmail("compat-guest-free@example.test");
      setUserProfileRole(profile.id, "guest");
      const result = authorizeOpenAiCompatibleHttpSession({
        agentId: "main",
        sessionKey: "agent:main:openai-user:compat-fresh-free",
        requestAuth: identityRequestAuth(profile.id),
        senderIsOwner: false,
      });
      expect(result).toEqual({ allowed: true });
    });
  });

  it("refuses an existing unsandboxed session for a sandbox-required role", async () => {
    await withOpenClawTestState({ label: "compat-sandbox-existing" }, async () => {
      const cfg = roleConfig({ guestSandbox: "required" });
      runtime.cfg = cfg;
      const profile = ensureProfileForEmail("compat-guest-existing@example.test");
      setUserProfileRole(profile.id, "guest");
      const sessionKey = "agent:main:openai-user:compat-existing-host";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "compat-existing-host",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      );
      const result = authorizeOpenAiCompatibleHttpSession({
        agentId: "main",
        sessionKey,
        requestAuth: identityRequestAuth(profile.id),
        senderIsOwner: false,
      });
      expect(result).toEqual({
        allowed: false,
        message: expect.stringMatching(/requires a sandboxed session/i),
      });
    });
  });

  it("allows an existing sandbox-required session for a sandbox-required role", async () => {
    await withOpenClawTestState({ label: "compat-sandbox-stamped" }, async () => {
      const cfg = roleConfig({ guestSandbox: "required" });
      runtime.cfg = cfg;
      const profile = ensureProfileForEmail("compat-guest-stamped@example.test");
      setUserProfileRole(profile.id, "guest");
      const sessionKey = "agent:main:openai-user:compat-existing-sandbox";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "compat-existing-sandbox",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: profile.id },
          sandbox: "required",
        },
      );
      const result = authorizeOpenAiCompatibleHttpSession({
        agentId: "main",
        sessionKey,
        requestAuth: identityRequestAuth(profile.id),
        senderIsOwner: false,
      });
      expect(result).toEqual({ allowed: true });
    });
  });

  it("preserves trusted shared-secret callers without a session", async () => {
    await withOpenClawTestState({ label: "compat-sandbox-shared-secret" }, async () => {
      runtime.cfg = roleConfig({ guestSandbox: "required" });
      const result = authorizeOpenAiCompatibleHttpSession({
        agentId: "main",
        sessionKey: "agent:main:openai-user:compat-fresh-shared-secret",
        requestAuth: OWNER_AUTH,
        senderIsOwner: true,
      });
      expect(result).toEqual({ allowed: true });
    });
  });
});
