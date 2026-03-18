import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { getOperatorDebSyncStatus } from "./deb-sync.js";

describe("deb sync status", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("surfaces direct Deb mode endpoints and lifecycle sync state", () => {
    withEnv(
      {
        OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
        OPENCLAW_OPERATOR_DEB_SHARED_SECRET: "deb-secret",
        OPENCLAW_OPERATOR_CONTROL_PLANE_URL: undefined,
        OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: undefined,
      },
      () => {
        expect(getOperatorDebSyncStatus()).toMatchObject({
          targetMode: "direct-deb",
          lifecycleSyncConfigured: true,
          baseUrl: "http://deb.internal:3010",
          readyEndpoint: "http://deb.internal:3010/ready",
          statusEndpoint: "http://deb.internal:3010/status",
          syncEndpoint: "http://deb.internal:3010/sync",
          updateEndpoint: "http://deb.internal:3010/update",
          taskEndpoint: null,
          eventEndpoint: "http://deb.internal:3010/operator/events",
          authEnv: "OPENCLAW_OPERATOR_DEB_SHARED_SECRET",
        });
      },
    );
  });

  it("prefers the control-plane proxy when both routes are configured", () => {
    withEnv(
      {
        OPENCLAW_OPERATOR_DEB_URL: "http://deb.internal:3010",
        OPENCLAW_OPERATOR_DEB_SHARED_SECRET: "deb-secret",
        OPENCLAW_OPERATOR_CONTROL_PLANE_URL: "http://tonya.internal:18789",
        OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET: "tonya-secret",
      },
      () => {
        expect(getOperatorDebSyncStatus()).toMatchObject({
          targetMode: "control-plane-proxy",
          lifecycleSyncConfigured: true,
          baseUrl: "http://tonya.internal:18789",
          readyEndpoint: "http://tonya.internal:18789/mission-control/api/project-ops/ready",
          statusEndpoint: "http://tonya.internal:18789/mission-control/api/project-ops/status",
          syncEndpoint: "http://tonya.internal:18789/mission-control/api/project-ops/sync",
          updateEndpoint: "http://tonya.internal:18789/mission-control/api/project-ops/update",
          taskEndpoint: "http://tonya.internal:18789/mission-control/api/project-ops/task",
          eventEndpoint:
            "http://tonya.internal:18789/mission-control/api/project-ops/operator/events",
          authEnv: "OPENCLAW_OPERATOR_CONTROL_PLANE_SHARED_SECRET",
        });
      },
    );
  });
});
