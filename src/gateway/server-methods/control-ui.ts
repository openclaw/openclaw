import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  ControlUiGitHubPreviewError,
  loadControlUiGitHubPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewTarget,
} from "../control-ui-github-preview.js";
import type { GatewayRequestHandlers } from "./types.js";

type LoadGitHubPreview = (
  target: ControlUiGitHubPreviewTarget,
) => ReturnType<typeof loadControlUiGitHubPreview>;

export function createControlUiHandlers(
  loadGitHubPreview: LoadGitHubPreview = loadControlUiGitHubPreview,
): GatewayRequestHandlers {
  return {
    "controlUi.githubPreview": async ({ params, respond }) => {
      const target = parseControlUiGitHubPreviewTarget(params);
      if (!target) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid controlUi.githubPreview params"),
        );
        return;
      }
      try {
        respond(true, await loadGitHubPreview(target), undefined);
      } catch (error) {
        const statusCode =
          error instanceof ControlUiGitHubPreviewError ? error.statusCode : undefined;
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "GitHub preview unavailable", {
            retryable: statusCode === 429 || statusCode === 502,
          }),
        );
      }
    },
  };
}

export const controlUiHandlers = createControlUiHandlers();
