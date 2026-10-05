import type { IncomingMessage, ServerResponse } from "node:http";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { parseControlUiUserAvatarPath } from "./control-ui-contract.js";
import { respondPlainText } from "./control-ui-http-utils.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-auth-utils.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { runWithGatewayHttpWorkAdmission } from "./server/http-work-admission.js";
const getSessionHistoryHttpModule = createLazyRuntimeModule(
  () => import("./sessions-history-http.js"),
);
const getUserProfilesHttpModule = createLazyRuntimeModule(() => import("./user-profiles-http.js"));

/** Audited frozen reads use existing HTTP auth and physical-source owners. */
export async function handleSuspendedReaderHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  routeAuth: GatewayHttpRequestAuthOptions,
  basePath: string,
  enabled: boolean,
  handleControlUi: () => Promise<boolean>,
) {
  return runWithGatewayHttpWorkAdmission(
    res,
    async () => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        respondPlainText(res, 503, "Gateway writer is permanently retired");
        return true;
      }
      const authority = await authorizeGatewayHttpRequestOrReply({ req, res, ...routeAuth });
      if (!authority) {
        return true;
      }
      authority.assertCurrent();
      if (/^\/sessions\/[^/]+\/history$/.test(requestPath)) {
        return (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(
          req,
          res,
          routeAuth,
        );
      }
      const avatar = parseControlUiUserAvatarPath(requestPath, basePath);
      if (avatar.matched) {
        return (await getUserProfilesHttpModule()).handleUserProfileAvatarHttpRequest(
          req,
          res,
          requestPath,
          { ...routeAuth, basePath },
        );
      }
      if (enabled && (await handleControlUi())) {
        return true;
      }
      respondPlainText(res, 503, "This route is unavailable on the frozen Gateway reader");
      return true;
    },
    true,
  );
}
