import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "../config/sessions/session-transcript-worker.types.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import * as rowReads from "./session-row-database-facts.js";
import * as projections from "./session-row-projection.js";

it("refuses startup and disposes its projection when initial rows fail after the first batch", async () => {
  const port = await getFreePort();
  const token = "startup-projection-synthetic-token";
  const state = await createOpenClawTestState({
    label: "startup-projection-warm",
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  const disposed = vi.fn();
  try {
    await state.writeConfig({
      gateway: { auth: { mode: "token", token }, controlUi: { enabled: false }, port },
      agents: { defaults: { model: "unit-test/model", utilityModel: "" } },
      plugins: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      cron: { enabled: false },
    });
    state.applyEnv();
    runOpenClawAgentWriteTransaction(
      () => {
        for (let index = 0; index <= MAX_SESSION_ROW_FACTS_KEYS; index++) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: `agent:main:startup-warm-${index}` },
            { sessionId: `startup-warm-${index}`, updatedAt: index + 1 },
          );
        }
      },
      { agentId: "main" },
    );
    const failure = new Error("Initial session row batch unavailable");
    const readFacts = rowReads.withSessionRowDatabaseFacts;
    let batches = 0;
    vi.spyOn(rowReads, "withSessionRowDatabaseFacts").mockImplementation(async (...args) => {
      if ((args[0].selected ?? args[0].dirty).size > 0 && ++batches > 1) {
        throw failure;
      }
      return readFacts(...args);
    });
    const createProjection = projections.createSessionRowProjection;
    vi.spyOn(projections, "createSessionRowProjection").mockImplementation(async (params) => {
      const projection = await createProjection(params);
      const dispose = projection.dispose;
      vi.spyOn(projection, "dispose").mockImplementation(() => {
        dispose();
        disposed();
      });
      return projection;
    });
    const startup = createGatewayKernel(port, {
      auth: { mode: "token", token },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    }).then((created) => {
      kernel = created;
    });
    await expect(startup).rejects.toBe(failure);
    expect(batches).toBeGreaterThan(1);
    expect(disposed).toHaveBeenCalledOnce();
    expect(getActiveGatewayRootWorkCount()).toBe(0);
    expect(getActiveSecretsRuntimeConfigSnapshot()).toBeNull();
  } finally {
    try {
      await kernel?.closeOnStartupFailure();
    } finally {
      vi.restoreAllMocks();
      await state.cleanup();
    }
  }
});
