import { expectDefined } from "@openclaw/normalization-core";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

export function createPersistedPluginCommandParams(
  cfg: OpenClawConfig,
  inbound: MsgContext,
  { workspaceDir }: { workspaceDir: string },
  sessionKey: string,
  storePath: string,
) {
  return (body = "/review-panel") => {
    const value = buildCommandTestParams(
      body,
      cfg,
      {
        ...inbound,
        Body: body,
        CommandBody: body,
        RawBody: body,
        // The fixture ingress was created with plain text; project this as the
        // authenticated command turn, as real command dispatch does.
        CommandAuthorized: true,
        CommandTurn: undefined,
      },
      { workspaceDir },
    );
    value.sessionKey = sessionKey;
    value.storePath = storePath;
    value.sessionEntry = expectDefined(
      loadSessionEntry({ agentId: "main", sessionKey, storePath }),
      "persisted command requester",
    );
    return value;
  };
}
