import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { ensureSessionEntrySync } from "../config/sessions/session-accessor.sqlite-initial-entry.js";
import * as entryReads from "../config/sessions/session-entry-read-runtime.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPluginGatewayMethodDescriptor } from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { dispatchAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "attributes pre-handler Workboard waits and preserves failure=%s",
  async (fails) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const sessionKey = "agent:main:private-fixture";
      ensureSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: "private-fixture",
          updatedAt: 1,
          visibility: "shared",
        },
      );
      let clock = 0;
      vi.spyOn(performance, "now").mockImplementation(() => clock);
      const read = entryReads.readSessionEntriesFromStoreInWorker;
      vi.spyOn(entryReads, "readSessionEntriesFromStoreInWorker").mockImplementation(
        async (...args) => {
          const result = await read(...args);
          clock += 1_200;
          return result;
        },
      );
      const log = createSubsystemLogger("test/workboard");
      vi.spyOn(log, "isEnabled").mockReturnValue(true);
      const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
      const error = new Error("private-handler-error");
      const method = "workboard.cards.list";
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        clock += 25;
        if (fails) {
          throw error;
        }
        respond(true, { cards: [] });
      });
      const registry = createGatewayMethodRegistry([
        createPluginGatewayMethodDescriptor({
          pluginId: "workboard",
          name: method,
          scope: "operator.read",
          handler,
        }),
      ]);
      const previous = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      try {
        const request = dispatchAuthorizationRequest(
          method,
          { sessionKey },
          {
            client: sharingPolicyClient({ scopes: ["operator.read"] }),
            methodRegistry: registry,
            context: {
              ...requestContext({ agents: { entries: { main: {} } } }),
              logGateway: log,
            },
          },
        );
        if (fails) {
          await expect(request).rejects.toBe(error);
        } else {
          expect(await request).toHaveBeenCalledWith(true, { cards: [] });
        }
        expect(handler).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledExactlyOnceWith("slow workboard cards list", {
          operation: method,
          elapsedMs: 1_225,
          phaseDurationsMs: expect.objectContaining({
            accessFacts: 1_200,
            handler: 25,
            "detail.sessionFacts.rows": 1_200,
          }),
        });
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(
          /private-fixture|private-handler-error/,
        );
      } finally {
        setDiagnosticsEnabledForProcess(previous);
      }
    });
  },
);
