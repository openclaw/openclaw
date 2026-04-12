import { vi } from "vitest";
import { loadBundledChannelSecretContractApi } from "./channel-contract-api.js";

const googleChatSecrets = loadBundledChannelSecretContractApi("googlechat");
const ircSecrets = loadBundledChannelSecretContractApi("irc");
const slackSecrets = loadBundledChannelSecretContractApi("slack");

if (
  !googleChatSecrets?.collectRuntimeConfigAssignments ||
  !ircSecrets?.collectRuntimeConfigAssignments ||
  !slackSecrets?.collectRuntimeConfigAssignments
) {
  throw new Error("Missing channel secret contract api");
}

function resolveAssignments(id: string) {
  if (id === "irc") {
    return ircSecrets.collectRuntimeConfigAssignments;
  }
  if (id === "slack") {
    return slackSecrets.collectRuntimeConfigAssignments;
  }
  if (id === "googlechat") {
    return googleChatSecrets.collectRuntimeConfigAssignments;
  }
  return undefined;
}

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
