import { expectTypeOf } from "vitest";
import type { OpenClawPluginServiceContext as CoreServiceContext } from "../../src/plugin-sdk/core.js";
import type {
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "../../src/plugin-sdk/diagnostic-runtime.js";
import type { OpenClawPluginServiceContext as PluginEntryServiceContext } from "../../src/plugin-sdk/plugin-entry.js";

type ListenerArgs<T extends { internalDiagnostics?: unknown }> =
  NonNullable<T["internalDiagnostics"]> extends { onEvent: infer TOnEvent }
    ? TOnEvent extends (listener: infer TListener) => unknown
      ? TListener extends (...args: infer TArgs) => unknown
        ? TArgs
        : never
      : never
    : never;

type ListenerPrivateData<T extends { internalDiagnostics?: unknown }> = ListenerArgs<T>[2];
type InternalDiagnostics<T extends { internalDiagnostics?: unknown }> = NonNullable<
  T["internalDiagnostics"]
>;
type TelemetryExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;

// plugin service diagnostics contract
// keeps host attribution out of public SDK listener declarations
expectTypeOf<
  ListenerPrivateData<PluginEntryServiceContext>
>().toEqualTypeOf<DiagnosticEventPrivateData>();
expectTypeOf<ListenerPrivateData<CoreServiceContext>>().toEqualTypeOf<DiagnosticEventPrivateData>();
expectTypeOf<ListenerArgs<PluginEntryServiceContext>["length"]>().toEqualTypeOf<3>();
expectTypeOf<ListenerArgs<CoreServiceContext>["length"]>().toEqualTypeOf<3>();
expectTypeOf<
  "hostPluginId" extends keyof ListenerPrivateData<PluginEntryServiceContext> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  "reportExporterHealth" extends keyof InternalDiagnostics<PluginEntryServiceContext> ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  "reportExporterHealth" extends keyof InternalDiagnostics<CoreServiceContext> ? true : false
>().toEqualTypeOf<false>();

// keeps the shipped telemetry exporter event union unchanged
expectTypeOf<TelemetryExporterEvent["status"]>().toEqualTypeOf<"started" | "failure" | "dropped">();
expectTypeOf<NonNullable<TelemetryExporterEvent["reason"]>>().toEqualTypeOf<
  | "configured"
  | "emit_failed"
  | "handler_failed"
  | "queue_full"
  | "shutdown_failed"
  | "start_failed"
  | "unsupported_protocol"
>();
expectTypeOf<
  "transport" extends keyof TelemetryExporterEvent ? true : false
>().toEqualTypeOf<false>();
expectTypeOf<
  "endpointMode" extends keyof TelemetryExporterEvent ? true : false
>().toEqualTypeOf<false>();
