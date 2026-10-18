import fs from "node:fs/promises";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  validateSkillsFileGetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveToCwd } from "../../agents/sessions/tools/path-utils.js";
import { root } from "../../infra/fs-safe.js";
import { shouldRejectHardlinkedPluginFiles } from "../../plugins/hardlink-policy.js";
import { resolveSkillDiscoveryLimits } from "../../skills/loading/skill-root-discovery.js";
import { resolveSkillTelemetrySourceValue } from "../../skills/loading/source.js";
import { prepareWorkspaceSkillEntries } from "../../skills/loading/workspace-skill-loader.js";
import { resolveSkillFileHost } from "../../skills/skill-file-host.js";
import { resolveSkillsAgentWorkspace } from "./skills-workspace-handler.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const skillsFilesHandlers: GatewayRequestHandlers = {
  "skills.files.get": async ({ params, respond, context, signal, hasCurrentClientAuthority }) => {
    if (!assertValidParams(params, validateSkillsFileGetParams, "skills.files.get", respond)) {
      return;
    }
    const resolved = resolveSkillsAgentWorkspace(params, context);
    if (!resolved.ok) {
      respond(false, undefined, resolved.error);
      return;
    }
    const assertCurrent = () => {
      if (
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        context.getRuntimeConfig() !== resolved.cfg
      ) {
        throw new Error("Skill file access changed; retry.");
      }
    };
    try {
      const requestedPath = path.resolve(resolveToCwd(params.path, resolved.workspaceDir));
      const { entries } = await prepareWorkspaceSkillEntries(
        resolved.workspaceDir,
        { config: resolved.cfg, agentId: resolved.agentId, agentSkillFilter: "ignore" },
        assertCurrent,
      );
      // Discovery is the allowlist. Workspace-host and node paths must never
      // authorize reads from an identically named path on the Gateway host.
      const requestedRealPath = await fs.realpath(requestedPath);
      const entry = entries.find(
        ({ skill }) =>
          resolveSkillFileHost(skill) !== "workspace" &&
          !skill.filePath.startsWith("node://") &&
          (path.resolve(skill.filePath) === requestedPath ||
            path.resolve(skill.filePath) === requestedRealPath),
      );
      if (!entry) {
        throw new Error("Skill file is not installed locally for this agent");
      }
      const { skill } = entry;
      const skillRoot = await root(skill.baseDir);
      assertCurrent();
      const read = await skillRoot.read("SKILL.md", {
        maxBytes: resolveSkillDiscoveryLimits(resolved.cfg).maxSkillFileBytes,
        symlinks: "follow-within-root",
        hardlinks: shouldRejectHardlinkedPluginFiles({
          origin:
            resolveSkillTelemetrySourceValue(skill.source) === "bundled" ? "bundled" : "workspace",
          rootDir: skill.baseDir,
        })
          ? "reject"
          : "allow",
      });
      assertCurrent();
      respond(true, {
        path: skill.filePath,
        name: skill.name,
        content: read.buffer.toString("utf8"),
      });
    } catch {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Skill file is unavailable locally, outside its skill directory, or exceeds the skill file size limit",
        ),
      );
    }
  },
};
