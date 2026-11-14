import type { Page } from "playwright";
import type {
  ControlUiMockGateway,
  ControlUiMockGatewayInstallOptions,
  MockGatewayControls,
  MockGatewayWindow,
} from "./control-ui-e2e-contract.ts";
import {
  captureControlUiE2eFailureDiagnostics,
  type ControlUiE2eDiagnosticEvent,
} from "./control-ui-e2e-diagnostics.ts";
import { controlUiE2eWaitTimeoutMs } from "./control-ui-e2e-readiness.ts";

let mockRequestBindingSequence = 0;

type GatewayMutation = {
  [K in keyof ControlUiMockGateway]: ControlUiMockGateway[K] extends (...args: never[]) => infer R
    ? R extends void
      ? K
      : never
    : never;
}[keyof ControlUiMockGateway];

export async function installMockGatewayScript(
  page: Page,
  script: string,
  options: ControlUiMockGatewayInstallOptions = {},
): Promise<void> {
  const handlers = options.requestHandlers;
  let content = script + (options.afterInitScript ?? "");
  if (handlers) {
    const binding = `__openclawMockRequest${++mockRequestBindingSequence}`;
    await page.exposeBinding(binding, (_source, method: string, params: unknown) =>
      handlers[method]!(params),
    );
    content += `;for (const method of ${JSON.stringify(Object.keys(handlers))}) {
      window.openclawControlUiE2eGateway.setRequestHandler(method, ({ params, respond }) => {
        window[${JSON.stringify(binding)}](method, params).then(respond, (error) => respond({
          __mockError: { code: "MOCK_REQUEST_HANDLER_FAILED", message: String(error) }
        }));
      });
    }`;
  }
  await page.addInitScript({ content });
}

export function createMockGatewayControls(
  page: Page,
  defaultSessionKey: string,
  diagnosticEvents: ControlUiE2eDiagnosticEvent[],
  methodResponses: Record<string, unknown>,
): MockGatewayControls {
  const mutate = async <K extends GatewayMutation>(
    method: K,
    ...args: Parameters<ControlUiMockGateway[K]>
  ): Promise<void> => {
    const operation: { method: GatewayMutation; args: unknown[] } = { method, args };
    await page.evaluate(({ method: targetMethod, args: values }) => {
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway is not installed");
      }
      Reflect.apply(gateway[targetMethod], gateway, values);
    }, operation);
  };
  const emitGatewayEvent: MockGatewayControls["emitGatewayEvent"] = (...args) =>
    mutate("emit", ...args);

  const getRequests = async (
    method?: string,
    match?: Record<string, unknown>,
    options?: { exactParams?: boolean },
  ) =>
    page.evaluate(
      ({ targetMethod, requestMatch, requestOptions }) => {
        const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
        return gateway?.findRequests(targetMethod, requestMatch, requestOptions) ?? [];
      },
      { targetMethod: method, requestMatch: match, requestOptions: options },
    );

  return {
    closeLatest: (...args) => mutate("closeLatest", ...args),
    deliverLatest: (...args) => mutate("deliverLatest", ...args),
    async deferNext(method, match, options) {
      return await page.evaluate(
        ({ targetMethod, requestMatch, requestOptions }) => {
          const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
          if (!gateway) {
            throw new Error("Mock Gateway is not installed");
          }
          return gateway.deferNext(targetMethod, requestMatch, requestOptions);
        },
        { targetMethod: method, requestMatch: match, requestOptions: options },
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
    getSocketCount: () =>
      page.evaluate(
        () => (window as MockGatewayWindow).openclawControlUiE2eGateway?.socketCount() ?? 0,
      ),
    getSocketUrls: () =>
      page.evaluate(
        () => (window as MockGatewayWindow).openclawControlUiE2eGateway?.socketUrls() ?? [],
      ),
    rejectDeferred: (...args) => mutate("rejectDeferred", ...args),
    resolveDeferred: (...args) => mutate("resolveDeferred", ...args),
    suspendLatest: () => mutate("suspendLatest"),
    setOnline: (...args) => mutate("setOnline", ...args),
    setGatewayBootId: (...args) => mutate("setGatewayBootId", ...args),
    setServerBuildId: (...args) => mutate("setServerBuildId", ...args),
    setOperatorScopes: (...args) => mutate("setOperatorScopes", ...args),
    setHistoryMessages: (...args) => mutate("setHistoryMessages", ...args),
    async setMethodResponse(method, payload) {
      methodResponses[method] = payload;
      await mutate("setMethodResponse", method, payload);
    },
    setSessionsListResponse: (...args) => mutate("setSessionsListResponse", ...args),
    setSessionSharingPolicy: (...args) => mutate("setSessionSharingPolicy", ...args),
    async waitForRequest(method, options) {
      const deadline = Date.now() + controlUiE2eWaitTimeoutMs;
      const { after, match, exactParams } = options ?? {};
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await page.waitForFunction(
            ({ targetMethod, priorCount, requestMatch, requestOptions }) => {
              const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
              const matching =
                gateway?.findRequests(targetMethod, requestMatch, requestOptions) ?? [];
              return matching.length > priorCount;
            },
            {
              targetMethod: method,
              priorCount: after ?? 0,
              requestMatch: match,
              requestOptions: { exactParams },
            },
            // Request capture is non-rendering state. Interval polling avoids background-page
            // requestAnimationFrame throttling when CI runs several headless pages concurrently.
            { polling: 25, timeout: Math.max(1, deadline - Date.now()) },
          );
          const matching = await getRequests(method, match, { exactParams });
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
