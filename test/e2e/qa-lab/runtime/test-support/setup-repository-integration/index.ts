import type { OpenClawPluginApi, RepositoryIntegration } from "openclaw/plugin-sdk/plugin-entry";
import { SETUP_PROOF_GITHUB_TOKEN } from "./api.js";

export default {
  id: "setup-proof-repository",
  register(api: OpenClawPluginApi) {
    const preparedCapacity = api.pluginConfig?.preparedCapacity;
    if (preparedCapacity !== "image" && preparedCapacity !== "repository") {
      throw new Error("Setup proof requires an explicit prepared capacity kind");
    }
    const integration: RepositoryIntegration = {
      version: 1,
      preparedCapacity,
      resolveConnectionIdentity(context) {
        // Keep the native trusted-proxy email identity. Public GitHub does not
        // accept an invented Enterprise principal as a profile hint.
        context.assertCurrent();
        return undefined;
      },
      async withIdentity(context, run) {
        // The adapter supplies external credential data, never setup policy or an admission grant.
        // Native callbacks continue to own the original actor and operation authority.
        const assertCurrent = context.assertCurrent;
        assertCurrent();
        if (context.host !== "github.com") {
          throw new Error("Unexpected setup fixture repository host");
        }
        return await run({
          env: context.env,
          assertCurrent,
          readNativeCredential: async () => SETUP_PROOF_GITHUB_TOKEN,
        });
      },
    };
    api.registerRepositoryIntegration(integration);
  },
};
