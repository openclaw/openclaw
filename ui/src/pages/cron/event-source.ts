import {
  isJsonSchemaValueValid,
  type JsonSchemaValue,
} from "@openclaw/normalization-core/json-schema";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import type { CronFieldErrors, CronFormState } from "../../lib/cron/types.ts";
import { formatUiError } from "../../lib/format-error.ts";

export type McpEventDefinition = {
  name: string;
  description?: string;
  delivery?: string[];
  inputSchema: JsonSchemaValue;
  payloadSchema: JsonSchemaValue;
};
export type McpEventSubscription = {
  jobId: string;
  sourceIdentity: string;
  serverName: string;
  name: string;
  status: string;
  truncated: boolean;
  lastError?: string;
  nextAttemptAt?: number;
};
export type CronEventSourceView = {
  available: boolean;
  servers: string[];
  loading: boolean;
  error: string | null;
  events: McpEventDefinition[];
  subscriptions: McpEventSubscription[];
  statusError: string | null;
  onRefresh: () => void;
};

type Scope = {
  client: GatewayBrowserClient;
  agentId: string;
  serverName: string;
  jobId?: string;
  sourceIdentity?: string;
  isCurrent: () => boolean;
};

// Discovery is editor-owned. Retiring an editor or changing its agent/server
// invalidates both catalog pages and diagnostics before any late response publishes.
export class CronEventSourceController {
  loading = false;
  error: string | null = null;
  events: McpEventDefinition[] = [];
  subscriptions: McpEventSubscription[] = [];
  statusError: string | null = null;
  private generation = 0;
  constructor(private readonly notify: () => void) {}
  reset() {
    this.generation += 1;
    this.loading = false;
    this.error = null;
    this.events = [];
    this.subscriptions = [];
    this.statusError = null;
  }
  async load(scope: Scope) {
    this.reset();
    const generation = this.generation;
    const current = () => this.generation === generation && scope.isCurrent();
    this.loading = true;
    this.notify();
    const catalog = async () => {
      if (!scope.serverName) {
        return;
      }
      let cursor: string | undefined;
      const seen = new Set<string>();
      const events: McpEventDefinition[] = [];
      do {
        const result = await scope.client.request<{
          serverName: string;
          events: McpEventDefinition[];
          nextCursor?: string;
        }>("mcp.events.list", {
          agentId: scope.agentId,
          serverName: scope.serverName,
          ...(cursor ? { cursor } : {}),
        });
        if (!current()) {
          return;
        }
        if (result.serverName !== scope.serverName) {
          throw new Error(t("cron.events.catalogMismatch"));
        }
        if (seen.size >= 100 || events.length + result.events.length > 10_000) {
          throw new Error(t("cron.events.catalogLimit"));
        }
        events.push(...result.events);
        cursor = result.nextCursor;
        if (cursor && seen.has(cursor)) {
          throw new Error(t("cron.events.catalogCursor"));
        }
        if (cursor) {
          seen.add(cursor);
        }
      } while (cursor);
      this.events = events;
    };
    const loadCatalog = async () => {
      try {
        await catalog();
      } catch (error) {
        if (current()) {
          this.error = formatUiError(error);
        }
      }
    };
    const diagnostics = async () => {
      if (!scope.jobId) {
        return;
      }
      try {
        const result = await scope.client.request<{ subscriptions: McpEventSubscription[] }>(
          "mcp-events.status",
          {},
        );
        if (current()) {
          this.subscriptions = result.subscriptions.filter(
            (entry) => entry.jobId === scope.jobId && entry.sourceIdentity === scope.sourceIdentity,
          );
        }
      } catch (error) {
        if (current()) {
          this.statusError = formatUiError(error);
        }
      }
    };
    try {
      await Promise.all([loadCatalog(), diagnostics()]);
    } finally {
      if (current()) {
        this.loading = false;
        this.notify();
      }
    }
  }
}

export function resolveCronEventPatch(
  current: CronFormState,
  patch: Partial<CronFormState>,
): Partial<CronFormState> {
  if (patch.eventServer !== undefined && patch.eventServer !== current.eventServer) {
    return { ...patch, eventName: "", eventArguments: "{}" };
  }
  if (patch.eventName !== undefined && patch.eventName !== current.eventName) {
    return { ...patch, eventArguments: "{}" };
  }
  return patch;
}

export function validateCronEventSelection(
  form: CronFormState,
  view: Pick<CronEventSourceView, "available" | "loading" | "events" | "error">,
): CronFieldErrors {
  if (form.scheduleKind !== "event" || form.eventSource !== "mcp-events") {
    return {};
  }
  if (!view.available) {
    return { eventName: "cron.events.unavailable" };
  }
  if (view.loading) {
    return { eventName: "cron.events.loading" };
  }
  if (view.error) {
    return { eventName: "cron.events.discoveryFailed" };
  }
  const definition = view.events.find((event) => event.name === form.eventName);
  if (!definition) {
    return { eventName: "cron.events.eventNameRequired" };
  }
  try {
    if (!isJsonSchemaValueValid(definition.inputSchema, JSON.parse(form.eventArguments))) {
      return { eventArguments: "cron.events.eventArgumentsSchema" };
    }
  } catch {
    return { eventArguments: "cron.events.eventArgumentsInvalid" };
  }
  return {};
}
