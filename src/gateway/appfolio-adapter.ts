export type AppFolioExecuteIntentRequest = {
  requestId: string;
  intentSlug: string;
  unitId?: string;
  propertyId?: string;
  messageText: string;
  args: Record<string, unknown>;
};

export type AppFolioExecuteIntentResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retriable?: boolean;
  sourceLatencyMs: number;
};

export type AppFolioExecuteAdapter = (
  input: AppFolioExecuteIntentRequest,
) => Promise<AppFolioExecuteIntentResult>;

type AdapterDeps = {
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeSuccessPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const data = asRecord(record.data);
  if (Object.keys(data).length > 0) {
    return data;
  }
  if (Object.keys(record).length > 0) {
    return record;
  }
  return {};
}

export function createAppFolioExecuteAdapterFromEnv(deps?: AdapterDeps): AppFolioExecuteAdapter {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const nowMs = deps?.nowMs ?? (() => Date.now());
  const endpoint = process.env.OPENCLAW_APPFOLIO_EXECUTE_URL?.trim();
  const bearerToken = process.env.OPENCLAW_APPFOLIO_EXECUTE_TOKEN?.trim();

  return async (input: AppFolioExecuteIntentRequest): Promise<AppFolioExecuteIntentResult> => {
    if (!endpoint) {
      return {
        ok: false,
        errorCode: "api_adapter_not_configured",
        errorMessage: "OPENCLAW_APPFOLIO_EXECUTE_URL is not configured.",
        retriable: true,
        sourceLatencyMs: 0,
      };
    }

    const startedAt = nowMs();
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({
          requestId: input.requestId,
          intentSlug: input.intentSlug,
          unitId: input.unitId,
          propertyId: input.propertyId,
          messageText: input.messageText,
          args: input.args,
        }),
      });

      const sourceLatencyMs = Math.max(0, nowMs() - startedAt);
      if (!response.ok) {
        return {
          ok: false,
          errorCode: `api_http_${response.status}`,
          errorMessage: `AppFolio adapter returned HTTP ${response.status}.`,
          retriable: response.status >= 500,
          sourceLatencyMs,
        };
      }

      const payload = (await response.json()) as unknown;
      const record = asRecord(payload);

      if (record.ok === false) {
        return {
          ok: false,
          errorCode:
            typeof record.errorCode === "string" && record.errorCode.trim()
              ? record.errorCode
              : "api_execution_failed",
          errorMessage:
            typeof record.errorMessage === "string" && record.errorMessage.trim()
              ? record.errorMessage
              : "AppFolio adapter reported failure.",
          retriable: record.retriable === true,
          sourceLatencyMs,
        };
      }

      return {
        ok: true,
        data: normalizeSuccessPayload(payload),
        sourceLatencyMs,
      };
    } catch (error) {
      return {
        ok: false,
        errorCode: "api_request_failed",
        errorMessage: `AppFolio adapter request failed: ${toMessage(error)}`,
        retriable: true,
        sourceLatencyMs: Math.max(0, nowMs() - startedAt),
      };
    }
  };
}