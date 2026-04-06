// Manual facade. Keep loader boundary explicit.
type MattermostSenderAllowed = (params: {
  senderId: string;
  senderName?: string;
  allowFrom: string[];
  allowNameMatching?: boolean;
}) => boolean;
type FacadeModule = {
  isMattermostSenderAllowed: MattermostSenderAllowed;
};
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "mattermost",
    artifactBasename: "policy-api.js",
  });
}
export const isMattermostSenderAllowed: FacadeModule["isMattermostSenderAllowed"] = ((...args) =>
  loadFacadeModule()["isMattermostSenderAllowed"](
    ...args,
  )) as FacadeModule["isMattermostSenderAllowed"];
