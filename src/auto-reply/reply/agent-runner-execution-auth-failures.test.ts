import { describe, expect, it } from "vitest";
import { OAuthRefreshFailureError } from "../../agents/auth-profiles/oauth-refresh-failure.js";
import { createCliOutputFailoverError } from "../../agents/cli-runner/output-error.js";
import { FailoverError } from "../../agents/failover-error.js";
import { MissingProviderAuthError, ProviderAuthError } from "../../agents/model-auth.js";
import type { TemplateContext } from "../templating.js";
import {
  setupAgentRunnerExecutionTestState,
  getExecuteAgentTurnForTest,
  createRunAgentTurnParams,
  createFollowupRun,
  createMinimalRunAgentTurnParams,
  createTestFallbackSummaryError,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();

const providerLoginPresentation = (command: string) => ({
  blocks: [
    {
      type: "buttons",
      buttons: [
        {
          label: "Sign in",
          action: { type: "command", command },
        },
      ],
    },
  ],
});
const PROVIDER_LOGIN_PRESENTATION = providerLoginPresentation("/login openai");

describe("executeAgentTurn: authentication failures", () => {
  it("preserves OAuth profile guidance through fallback summaries", async () => {
    const refreshError = new OAuthRefreshFailureError({
      provider: "openai",
      profileId: "openai:user@example.com",
      message: "invalid_grant",
    });
    const failoverError = new FailoverError("OpenAI OAuth failed", {
      reason: "auth",
      provider: "openai",
      model: "gpt-5.5",
      profileId: "openai:user@example.com",
      authProfileFailure: { allInCooldown: false },
      status: 401,
      cause: refreshError,
    });
    const summaryError = createTestFallbackSummaryError({
      message: "All models failed",
      attempts: [
        {
          provider: "openai",
          model: "gpt-5.5",
          error: "OpenAI OAuth failed",
          reason: "auth",
        },
      ],
      soonestCooldownExpiry: null,
      cause: failoverError,
    });
    state.runEmbeddedAgentMock.mockRejectedValueOnce(summaryError);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("--profile-id 'openai:user@example.com'");
      expect(result.payload.presentation).toEqual(PROVIDER_LOGIN_PRESENTATION);
    }
  });

  it("omits OAuth profile ids from group reauth guidance", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({
        provider: "openai",
        profileId: "openai:user@example.com",
        message: "invalid_grant",
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "whatsapp",
          MessageSid: "msg",
          ChatType: "group",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("openclaw models auth login --provider openai");
      expect(result.payload.text).not.toContain("user@example.com");
      expect(result.payload.presentation).toEqual(PROVIDER_LOGIN_PRESENTATION);
    }
  });

  it.each([["xai", "/login xai"]])(
    "keeps disabled %s OAuth profiles actionable on later turns",
    async (provider, command) => {
      state.runEmbeddedAgentMock.mockRejectedValueOnce(
        new FailoverError("All OpenAI auth profiles are unavailable", {
          reason: "auth_permanent",
          provider,
          model: "fixture-model",
          authMode: "oauth",
          authProfileFailure: { allInCooldown: true },
        }),
      );

      const executeAgentTurn = await getExecuteAgentTurnForTest();
      const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

      expect(result.kind).toBe("final");
      if (result.kind === "final") {
        expect(result.payload.text).toContain(command);
        expect(result.payload.presentation).toEqual(providerLoginPresentation(command));
      }
    },
  );

  it.each([
    {
      label: "transient OpenAI refresh failures",
      error: new OAuthRefreshFailureError({
        provider: "openai",
        message: "temporary upstream issue",
      }),
    },
  ])("does not offer provider login for $label", async ({ error }) => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.presentation).toBeUndefined();
    }
  });

  it("surfaces Agent SDK OAuth session expiry in Discord channels", async () => {
    const error = createCliOutputFailoverError({
      output: {
        text: "",
        errorText: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
      provider: "claude-cli",
      model: "claude-opus-5",
    });
    if (!error) {
      throw new Error("expected CLI output failure");
    }
    state.runEmbeddedAgentMock.mockRejectedValueOnce(error);

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({
        sessionCtx: {
          Provider: "discord",
          Surface: "discord",
          ChatType: "channel",
          MessageSid: "msg",
        } as unknown as TemplateContext,
      }),
    );

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Your model provider needs a new login. Send `/login` from a private chat or Control UI session. Where shown, you can also select **Sign in**. You can also re-auth with `claude auth login && openclaw models auth login --provider anthropic --method cli` on the gateway.",
      );
      expect(result.payload.presentation).toEqual(providerLoginPresentation("/login"));
    }
  });

  it("surfaces typed missing API-key auth guidance without parsing the message", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new MissingProviderAuthError("openai", {
        mode: "api-key",
        source: "env: OPENAI_API_KEY",
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Couldn't connect to OpenAI. Run `openclaw doctor --fix`, then try again. If it still fails, open Models in the Control UI or run `openclaw configure`.",
      );
    }
  });

  it("formats auth-profile failover copy from typed FailoverError metadata", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError("Auth profile failover exhausted for provider openai", {
        reason: "auth",
        provider: "openai",
        status: 401,
        authProfileFailure: { allInCooldown: true },
        cause: new Error("invalid_grant"),
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toContain("Couldn't sign in to openai.");
      expect(result.payload.text).toContain("openclaw configure");
      expect(result.payload.text).not.toContain("invalid_grant");
      expect(result.payload.text).not.toContain("Auth profile failover exhausted");
    }
  });

  it("renders bounded recovery when the selected auth profile is unavailable", async () => {
    state.isInternalMessageChannelMock.mockReturnValue(true);
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new FailoverError('Codex app-server auth profile "openai:private" was not found', {
        reason: "auth",
        provider: "openai",
        status: 401,
        code: "selected_auth_profile_unavailable",
        authProfileFailure: { allInCooldown: false },
        cause: new Error("arbitrary plugin detail for openai:private"),
      }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "This saved login isn't available. Choose another login under Models in the Control UI or run `openclaw configure`.",
      );
      expect(result.payload.text).not.toContain("openai:private");
      expect(result.payload.text).not.toContain("arbitrary plugin detail");
      expect(result.payload.text).not.toContain("/login");
      expect(result.payload.presentation).toBeUndefined();
    }
  });

  it("falls back to a generic provider message for unsafe missing-key provider ids", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new ProviderAuthError(
        "missing-provider-auth",
        "openai`\nrm -rf /",
        'No API key found for provider "openai`\nrm -rf /".',
      ),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createRunAgentTurnParams(createFollowupRun()));

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ This AI service isn't set up yet. Sign in under Models in the Control UI or run `openclaw configure`.",
      );
    }
  });

  it("falls back to a generic reauth command when the provider in the OAuth error is unsafe", async () => {
    state.runEmbeddedAgentMock.mockRejectedValueOnce(
      new OAuthRefreshFailureError({ provider: "openai`\nrm -rf /", message: "invalid_grant" }),
    );

    const executeAgentTurn = await getExecuteAgentTurnForTest();
    const result = await executeAgentTurn(createRunAgentTurnParams(createFollowupRun()));

    expect(result.kind).toBe("final");
    if (result.kind === "final") {
      expect(result.payload.text).toBe(
        "⚠️ Your model provider needs a new login. Send `/login` from a private chat or Control UI session. Where shown, you can also select **Sign in**. You can also re-auth with `openclaw models auth login` on the gateway.",
      );
      expect(result.payload.presentation).toEqual(providerLoginPresentation("/login"));
    }
  });
});
