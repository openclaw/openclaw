// Compile-time contract guard for the shipped agent-runtime avatar surface.
import type { AgentAvatarResolution } from "../../src/plugin-sdk/agent-runtime.js";

const legacyLocalResolution: AgentAvatarResolution = {
  kind: "local",
  filePath: "/workspace/avatar.png",
  source: "avatar.png",
};
const internalFileHelperIsPrivate: "prepareLocalAgentAvatarFile" extends keyof typeof import("../../src/plugin-sdk/agent-runtime.js")
  ? true
  : false = false;

void legacyLocalResolution;
void internalFileHelperIsPrivate;
