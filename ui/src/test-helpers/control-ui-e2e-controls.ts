import type { Page } from "playwright";
import type { MockGatewayControls, MockGatewayWindow } from "./control-ui-e2e-contract.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  type ControlUiE2eDiagnosticEvent,
} from "./control-ui-e2e-diagnostics.ts";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e-readiness.ts";

export function createMockGatewayControls(
  page: Page,
  defaultSessionKey: string,
  diagnosticEvents: ControlUiE2eDiagnosticEvent[],
  methodResponses: Record<string, unknown>,
): MockGatewayControls {
  const emitGatewayEvent = async (event: string, payload?: unknown) => {
    await page.evaluate(
      ({ eventName, eventPayload }) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.emit(eventName, eventPayload);
      },
      { eventName: event, eventPayload: payload },
    );
  };

  const deliverLatest = async (frame: unknown) => {
    await page.evaluate((payload) => {
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway is not installed");
      }
      gateway.deliverLatest(payload);
    }, frame);
  };

  const getRequests = async (method?: string, match?: Record<string, unknown>) =>
    page.evaluate(
      ({ targetMethod, requestMatch }) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.findRequests(targetMethod, requestMatch) ?? [];
      },
      { targetMethod: method, requestMatch: match },
    );

  return {
    async closeLatest(code, reason) {
      await page.evaluate(
        ({ closeCode, closeReason }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.closeLatest(closeCode, closeReason);
        },
        { closeCode: code, closeReason: reason },
      );
    },
    deliverLatest,
    async deferNext(method, match) {
      await page.evaluate(
        ({ targetMethod, requestMatch }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.deferNext(targetMethod, requestMatch);
        },
        { targetMethod: method, requestMatch: match },
      );
    },
    async emitChatFinal(params) {
      await emitGatewayEvent("chat", {
        message: {
          content: [{ text: params.text, type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId: params.runId,
        sessionKey: params.sessionKey ?? defaultSessionKey,
        state: "final",
      });
    },
    emitGatewayEvent,
    getRequests,
    async getSessionRow(key) {
      return page.evaluate((sessionKey) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        return gateway.getSessionRow(sessionKey);
      }, key);
    },
    async getSocketCount() {
      return await page.evaluate(() => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.socketCount() ?? 0;
      });
    },
    async getSocketUrls() {
      return await page.evaluate(() => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.socketUrls() ?? [];
      });
    },
    async rejectDeferred(method, error) {
      await page.evaluate(
        ({ targetMethod, responseError }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.rejectDeferred(targetMethod, responseError);
        },
        { targetMethod: method, responseError: error },
      );
    },
    async resolveDeferred(method, payload) {
      await page.evaluate(
        ({ targetMethod, responsePayload }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.resolveDeferred(targetMethod, responsePayload);
        },
        { targetMethod: method, responsePayload: payload },
      );
    },
    async suspendLatest() {
      await page.evaluate(() => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.suspendLatest();
      });
    },
    async setOnline(online) {
      await page.evaluate((nextOnline) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setOnline(nextOnline);
      }, online);
    },
    async setGatewayBootId(bootId) {
      await page.evaluate((nextBootId) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setGatewayBootId(nextBootId);
      }, bootId);
    },
    async setServerBuildId(buildId) {
      await page.evaluate((nextBuildId) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setServerBuildId(nextBuildId);
      }, buildId);
    },
    async setOperatorScopes(scopes) {
      await page.evaluate((nextScopes) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setOperatorScopes(nextScopes);
      }, scopes);
    },
    async setHistoryMessages(messages) {
      await page.evaluate((nextMessages) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setHistoryMessages(nextMessages);
      }, messages);
    },
    async setMethodResponse(method, payload) {
      methodResponses[method] = payload;
      await page.evaluate(
        ({ targetMethod, responsePayload }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          gateway.setMethodResponse(targetMethod, responsePayload);
        },
        { targetMethod: method, responsePayload: payload },
      );
    },
    async setSessionsListResponse(payload) {
      await page.evaluate((responsePayload) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setSessionsListResponse(responsePayload);
      }, payload);
    },
    async setSessionSharingPolicy(policy) {
      await page.evaluate((nextPolicy) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        gateway.setSessionSharingPolicy(nextPolicy);
      }, policy);
    },
    async waitForRequest(method, options) {
      const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
      const after = options?.after;
      const match = options?.match;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.waitForFunction(
            ({ targetMethod, priorCount, requestMatch }) => {
              const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
              const matching = gateway?.findRequests(targetMethod, requestMatch) ?? [];
              return matching.length > (priorCount ?? 0);
            },
            { targetMethod: method, priorCount: after ?? 0, requestMatch: match },
            // Request capture is non-rendering state. Interval polling avoids background-page
            // requestAnimationFrame throttling when CI runs several headless pages concurrently.
            { polling: 25, timeout: Math.max(1, deadline - Date.now()) },
          );
          const matching = await getRequests(method, match);
          // With an `after` cursor, return the first NEW request; otherwise keep
          // the historical latest-match behavior existing callers rely on.
          const request = after === undefined ? matching.at(-1) : matching.at(after);
          if (request) {
            return request;
          }
        } catch (error) {
          const contextReset =
            error instanceof Error &&
            (error.message.includes("Execution context was destroyed") ||
              error.message.includes("Cannot find context with specified id"));
          // Intentional stale-build reloads replace the page context once while connecting.
          if (contextReset && attempt === 0 && !page.isClosed()) {
            continue;
          }
          if (error instanceof Error && error.name === "TimeoutError") {
            await captureControlUiE2eFailureDiagnostics(page, {
              error,
              label: method,
              pageEvents: diagnosticEvents,
            });
          }
          throw error;
        }
      }
      throw new Error(`No mock Gateway request found for ${method}`);
    },
  };
}
