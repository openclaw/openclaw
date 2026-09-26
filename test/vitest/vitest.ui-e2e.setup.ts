// Per-file setup leases the shard-scoped production bundle through the test helper.
import { inject } from "vitest";
import {
  setSharedControlUiE2eServerBaseUrl,
  type ControlUiE2eBuildIdentity,
} from "../../ui/src/test-helpers/control-ui-e2e-shared-preview.ts";

declare module "vitest" {
  export interface ProvidedContext {
    controlUiE2eServerBaseUrl: string | null;
    controlUiE2eServerBuildInfo: ControlUiE2eBuildIdentity | null;
  }
}

const serverBaseUrl = inject("controlUiE2eServerBaseUrl");
if (serverBaseUrl) {
  setSharedControlUiE2eServerBaseUrl(serverBaseUrl, inject("controlUiE2eServerBuildInfo"));
}
