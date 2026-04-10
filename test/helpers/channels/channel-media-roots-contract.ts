import { loadBundledPluginContractApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type IMessageContractSurface = typeof import("@openclaw/imessage/contract-api.js");

const {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} = loadBundledPluginContractApiSync<IMessageContractSurface>("imessage");

export {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
};
