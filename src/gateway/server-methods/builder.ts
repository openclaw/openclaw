import path from "node:path";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { resolveActiviAgentDir } from "../../agents/agent-paths.js";
import { upsertAuthProfile } from "../../agents/auth-profiles.js";
import {
  applyAgentConfig,
  findAgentEntryIndex,
  listAgentEntries,
} from "../../commands/agents.config.js";
import {
  setAnthropicApiKey,
  setOpenrouterApiKey,
  setGeminiApiKey,
} from "../../commands/onboard-auth.credentials.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { ensureAgentWorkspace } from "../../agents/workspace.js";
import { sanitizeIdentityLine } from "./agents.js";
import fs from "node:fs/promises";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateBuilderSetApiKeyParams,
  validateBuilderCreateAgentParams,
  validateBuilderDeployAgentParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";
import { DEFAULT_IDENTITY_FILENAME } from "../../agents/workspace.js";

const resolveAuthAgentDir = (agentDir?: string) => agentDir ?? resolveActiviAgentDir();

export const builderHandlers: GatewayRequestHandlers = {
  "builder.setApiKey": async ({ params, respond }) => {
    if (!validateBuilderSetApiKeyParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid builder.setApiKey params: ${formatValidationErrors(
            validateBuilderSetApiKeyParams.errors,
          )}`,
        ),
      );
      return;
    }

    const provider = String(params.provider ?? "").trim().toLowerCase();
    const apiKey = String(params.apiKey ?? "").trim();
    const profileId = params.profileId?.trim() || `${provider}:default`;
    const agentId = params.agentId?.trim();

    // Resolve agent directory if agentId provided
    let agentDir: string | undefined;
    if (agentId) {
      const cfg = loadConfig();
      agentDir = resolveAgentDir(cfg, agentId);
    }

    try {
      // Use existing helper functions for common providers
      switch (provider) {
        case "anthropic":
          await setAnthropicApiKey(apiKey, agentDir);
          break;
        case "openrouter":
          await setOpenrouterApiKey(apiKey, agentDir);
          break;
        case "google":
        case "gemini":
          await setGeminiApiKey(apiKey, agentDir);
          break;
        default:
          // Generic provider support via upsertAuthProfile (includes OpenAI, etc.)
          upsertAuthProfile({
            profileId,
            credential: {
              type: "api_key",
              provider,
              key: apiKey,
            },
            agentDir: resolveAuthAgentDir(agentDir),
          });
      }

      respond(
        true,
        {
          ok: true as const,
          provider,
          profileId,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `Failed to set API key: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },

  "builder.createAgent": async ({ params, respond }) => {
    if (!validateBuilderCreateAgentParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid builder.createAgent params: ${formatValidationErrors(
            validateBuilderCreateAgentParams.errors,
          )}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const rawName = String(params.name ?? "").trim();
    const agentId = normalizeAgentId(rawName);

    if (agentId === DEFAULT_AGENT_ID) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `"${DEFAULT_AGENT_ID}" is reserved`),
      );
      return;
    }

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) >= 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" already exists`),
      );
      return;
    }

    // Resolve workspace
    const workspaceDir = params.workspace
      ? resolveUserPath(String(params.workspace).trim())
      : resolveAgentWorkspaceDir(cfg, agentId);

    // Apply agent config
    let nextConfig = applyAgentConfig(cfg, {
      agentId,
      name: rawName,
      workspace: workspaceDir,
      ...(params.model ? { model: params.model } : {}),
    });
    const agentDir = resolveAgentDir(nextConfig, agentId);
    nextConfig = applyAgentConfig(nextConfig, { agentId, agentDir });

    // Ensure workspace exists
    const skipBootstrap = Boolean(nextConfig.agents?.defaults?.skipBootstrap);
    await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: !skipBootstrap });
    await fs.mkdir(resolveSessionTranscriptsDirForAgent(agentId), { recursive: true });

    // Write config
    await writeConfigFile(nextConfig);

    // Write IDENTITY.md
    const identityPath = path.join(workspaceDir, DEFAULT_IDENTITY_FILENAME);
    const identity = params.identity || {};
    const safeName = sanitizeIdentityLine(identity.name || rawName);
    const lines = [
      "",
      `- Name: ${safeName}`,
      ...(identity.emoji || params.emoji
        ? [`- Emoji: ${sanitizeIdentityLine(identity.emoji || params.emoji || "")}`]
        : []),
      ...(identity.avatar || params.avatar
        ? [`- Avatar: ${sanitizeIdentityLine(identity.avatar || params.avatar || "")}`]
        : []),
      "",
    ];
    await fs.appendFile(identityPath, lines.join("\n"), "utf-8");

    respond(
      true,
      {
        ok: true as const,
        agentId,
        name: rawName,
        workspace: workspaceDir,
      },
      undefined,
    );
  },

  "builder.deployAgent": async ({ params, respond }) => {
    if (!validateBuilderDeployAgentParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid builder.deployAgent params: ${formatValidationErrors(
            validateBuilderDeployAgentParams.errors,
          )}`,
        ),
      );
      return;
    }

    const agentId = String(params.agentId ?? "").trim();
    const cfg = loadConfig();

    if (findAgentEntryIndex(listAgentEntries(cfg), agentId) < 0) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${agentId}" does not exist`),
      );
      return;
    }

    // Apply deployment config if provided
    let nextConfig = cfg;
    if (params.config) {
      const updates: {
        model?: string;
      } = {};
      if (params.config.model) {
        updates.model = params.config.model;
      }
      nextConfig = applyAgentConfig(cfg, {
        agentId,
        ...updates,
      });
      await writeConfigFile(nextConfig);
    }

    // TODO: Apply tools/skills if provided
    // This would require additional config helpers

    respond(
      true,
      {
        ok: true as const,
        agentId,
        deployed: true,
      },
      undefined,
    );
  },
};
