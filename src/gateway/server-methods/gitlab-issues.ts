import {
  isGitLabIssueWrite,
  parseGitLabIssueOperation,
} from "@openclaw/gateway-protocol/gitlab-issues";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/schema/error-codes.js";
import { capturePluginLifecycleAuthority } from "../../plugins/registry-lifecycle.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { executeGitLabIssueOperation } from "../gitlab-issues-api.js";
import { preparePersonalForgeToolAction } from "./personal-forge-tool-authorization.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

const handleGitLabIssues: GatewayRequestHandler = async (options) => {
  const operation = parseGitLabIssueOperation(options.params);
  const write = options.req.method === "tools.gitlab.issues.write";
  if (!operation || isGitLabIssueWrite(operation) !== write) {
    respondError(options.respond, ErrorCodes.INVALID_REQUEST, "Invalid GitLab issue operation.");
    return;
  }
  const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const record = registry?.plugins.find((plugin) => plugin.id === "gitlab");
  const pluginCurrent =
    registry &&
    record &&
    capturePluginLifecycleAuthority(registry, record, { scopedRuntime: true });
  if (options.client?.internal?.pluginRuntimeOwnerId !== "gitlab" || !pluginCurrent) {
    respondError(
      options.respond,
      ErrorCodes.FORBIDDEN,
      "GitLab issues require an active gitlab_issues tool invocation.",
    );
    return;
  }
  try {
    const requester = await preparePersonalForgeToolAction(
      options,
      "gitlab_issues",
      write ? "operator.sessions.write" : "operator.sessions.read",
      "GitLab",
    );
    const assertCurrent = () => {
      requester.assertCurrent();
      if (!pluginCurrent()) {
        throw new Error("GitLab tool is no longer active.");
      }
    };
    assertCurrent();
    const service = options.context.gitlabOAuthService;
    if (!service) {
      throw new Error("GitLab is not configured. Ask an administrator to configure this server.");
    }
    const credential = await service.credential({ ...requester, assertCurrent });
    assertCurrent();
    const assertProjectAllowed = (projectId: number) => {
      assertCurrent();
      const config = options.context.getRuntimeConfig().gateway?.gitlab;
      if (!config || (config.projects && !config.projects.includes(projectId))) {
        throw new Error("This GitLab project is not enabled on this Gateway.");
      }
    };
    const result = await executeGitLabIssueOperation({
      operation,
      credential,
      signal: requester.signal,
      assertCurrent,
      assertProjectAllowed,
    });
    assertCurrent();
    options.respond(true, result, undefined);
  } catch (error) {
    respondError(
      options.respond,
      ErrorCodes.UNAVAILABLE,
      error instanceof Error
        ? error.message
        : "GitLab operation failed; inspect the original target before retrying a write.",
    );
  }
};

export const gitLabIssueHandlers: GatewayRequestHandlers = {
  "tools.gitlab.issues.read": handleGitLabIssues,
  "tools.gitlab.issues.write": handleGitLabIssues,
};
