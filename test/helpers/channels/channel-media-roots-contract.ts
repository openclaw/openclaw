import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type IMessageContractSurface = typeof import("@openclaw/imessage/contract-api.js");

const {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} = (await import(
  resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId: "imessage",
    artifactBasename: "contract-api.js",
  })
)) as IMessageContractSurface;

export {
  DEFAULT_IMESSAGE_ATTACHMENT_ROOTS,
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
};
