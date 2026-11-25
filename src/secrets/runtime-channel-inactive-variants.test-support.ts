/** Test support for inactive channel variants in secrets runtime scenarios. */
import { vi } from "vitest";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";

/** Test-only bootstrap registry mock for inactive channel secret surface variants. */
const googleChatSecrets = loadChannelSecretContractApi({ channelId: "googlechat", config: {} });
const ircSecrets = loadChannelSecretContractApi({ channelId: "irc", config: {} });
const mattermostSecrets = loadChannelSecretContractApi({ channelId: "mattermost", config: {} });
const slackSecrets = loadChannelSecretContractApi({ channelId: "slack", config: {} });

if (
  !googleChatSecrets?.collectRuntimeConfigAssignments ||
  !ircSecrets?.collectRuntimeConfigAssignments ||
  !mattermostSecrets?.collectRuntimeConfigAssignments ||
  !slackSecrets?.collectRuntimeConfigAssignments
) {
  throw new Error("Missing channel secret contract api");
}

const googleChatAssignments = googleChatSecrets.collectRuntimeConfigAssignments;
const ircAssignments = ircSecrets.collectRuntimeConfigAssignments;
const mattermostAssignments = mattermostSecrets.collectRuntimeConfigAssignments;
const slackAssignments = slackSecrets.collectRuntimeConfigAssignments;

function resolveAssignments(id: string) {
  if (id === "irc") {
    return ircAssignments;
  }
  if (id === "mattermost") {
    return mattermostAssignments;
  }
  if (id === "slack") {
    return slackAssignments;
  }
  if (id === "googlechat") {
    return googleChatAssignments;
  }
  return undefined;
}

// Runtime collectors resolve bootstrap channel contracts by id. This mock keeps
// the tested inactive variants on real bundled contracts without loading plugins.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => {
    const collectRuntimeConfigAssignments = resolveAssignments(id);
    return collectRuntimeConfigAssignments
      ? {
          secrets: { collectRuntimeConfigAssignments },
        }
      : undefined;
  },
  getBootstrapChannelSecrets: (id: string) => {
    const collectRuntimeConfigAssignments = resolveAssignments(id);
    return collectRuntimeConfigAssignments ? { collectRuntimeConfigAssignments } : undefined;
  },
}));
