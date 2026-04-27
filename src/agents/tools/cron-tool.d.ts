import { Type } from "typebox";
import { type AnyAgentTool } from "./common.js";
import { callGatewayTool } from "./gateway.js";
export declare const CronToolSchema: Type.TObject<{
    action: Type.TUnsafe<"status" | "list" | "wake" | "run" | "update" | "add" | "remove" | "runs">;
    gatewayUrl: Type.TOptional<Type.TString>;
    gatewayToken: Type.TOptional<Type.TString>;
    timeoutMs: Type.TOptional<Type.TNumber>;
    includeDisabled: Type.TOptional<Type.TBoolean>;
    job: Type.TOptional<Type.TObject<{
        name: Type.TOptional<Type.TString>;
        schedule: Type.TOptional<Type.TObject<{
            kind: Type.TOptional<Type.TUnsafe<"every" | "at" | "cron">>;
            at: Type.TOptional<Type.TString>;
            everyMs: Type.TOptional<Type.TNumber>;
            anchorMs: Type.TOptional<Type.TNumber>;
            expr: Type.TOptional<Type.TString>;
            tz: Type.TOptional<Type.TString>;
            staggerMs: Type.TOptional<Type.TNumber>;
        }>>;
        sessionTarget: Type.TOptional<Type.TString>;
        wakeMode: Type.TOptional<Type.TUnsafe<"now" | "next-heartbeat">>;
        payload: Type.TOptional<Type.TObject<{
            kind: Type.TOptional<Type.TUnsafe<"agentTurn" | "systemEvent">>;
            text: Type.TOptional<Type.TString>;
            message: Type.TOptional<Type.TString>;
            model: Type.TOptional<Type.TString>;
            thinking: Type.TOptional<Type.TString>;
            timeoutSeconds: Type.TOptional<Type.TNumber>;
            lightContext: Type.TOptional<Type.TBoolean>;
            allowUnsafeExternalContent: Type.TOptional<Type.TBoolean>;
            fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
            toolsAllow: Type.TSchema;
        }>>;
        delivery: Type.TOptional<Type.TObject<{
            mode: Type.TOptional<Type.TUnsafe<"none" | "announce" | "webhook">>;
            channel: Type.TOptional<Type.TString>;
            to: Type.TOptional<Type.TString>;
            bestEffort: Type.TOptional<Type.TBoolean>;
            accountId: Type.TOptional<Type.TString>;
            failureDestination: Type.TOptional<Type.TObject<{
                channel: Type.TOptional<Type.TString>;
                to: Type.TOptional<Type.TString>;
                accountId: Type.TOptional<Type.TString>;
                mode: Type.TOptional<Type.TUnsafe<"announce" | "webhook">>;
            }>>;
        }>>;
        agentId: Type.TOptional<Type.TString>;
        description: Type.TOptional<Type.TString>;
        enabled: Type.TOptional<Type.TBoolean>;
        deleteAfterRun: Type.TOptional<Type.TBoolean>;
        sessionKey: Type.TOptional<Type.TString>;
        failureAlert: Type.TOptional<Type.TUnsafe<false | Record<string, unknown>>>;
    }>>;
    jobId: Type.TOptional<Type.TString>;
    id: Type.TOptional<Type.TString>;
    patch: Type.TOptional<Type.TObject<{
        name: Type.TOptional<Type.TString>;
        schedule: Type.TOptional<Type.TObject<{
            kind: Type.TOptional<Type.TUnsafe<"every" | "at" | "cron">>;
            at: Type.TOptional<Type.TString>;
            everyMs: Type.TOptional<Type.TNumber>;
            anchorMs: Type.TOptional<Type.TNumber>;
            expr: Type.TOptional<Type.TString>;
            tz: Type.TOptional<Type.TString>;
            staggerMs: Type.TOptional<Type.TNumber>;
        }>>;
        sessionTarget: Type.TOptional<Type.TString>;
        wakeMode: Type.TOptional<Type.TUnsafe<"now" | "next-heartbeat">>;
        payload: Type.TOptional<Type.TObject<{
            kind: Type.TOptional<Type.TUnsafe<"agentTurn" | "systemEvent">>;
            text: Type.TOptional<Type.TString>;
            message: Type.TOptional<Type.TString>;
            model: Type.TOptional<Type.TString>;
            thinking: Type.TOptional<Type.TString>;
            timeoutSeconds: Type.TOptional<Type.TNumber>;
            lightContext: Type.TOptional<Type.TBoolean>;
            allowUnsafeExternalContent: Type.TOptional<Type.TBoolean>;
            fallbacks: Type.TOptional<Type.TArray<Type.TString>>;
            toolsAllow: Type.TSchema;
        }>>;
        delivery: Type.TOptional<Type.TObject<{
            mode: Type.TOptional<Type.TUnsafe<"none" | "announce" | "webhook">>;
            channel: Type.TOptional<Type.TString>;
            to: Type.TOptional<Type.TString>;
            bestEffort: Type.TOptional<Type.TBoolean>;
            accountId: Type.TOptional<Type.TString>;
            failureDestination: Type.TOptional<Type.TObject<{
                channel: Type.TOptional<Type.TString>;
                to: Type.TOptional<Type.TString>;
                accountId: Type.TOptional<Type.TString>;
                mode: Type.TOptional<Type.TUnsafe<"announce" | "webhook">>;
            }>>;
        }>>;
        description: Type.TOptional<Type.TString>;
        enabled: Type.TOptional<Type.TBoolean>;
        deleteAfterRun: Type.TOptional<Type.TBoolean>;
        agentId: Type.TOptional<Type.TString>;
        sessionKey: Type.TOptional<Type.TString>;
        failureAlert: Type.TOptional<Type.TUnsafe<false | Record<string, unknown>>>;
    }>>;
    text: Type.TOptional<Type.TString>;
    mode: Type.TOptional<Type.TUnsafe<"now" | "next-heartbeat">>;
    runMode: Type.TOptional<Type.TUnsafe<"force" | "due">>;
    contextMessages: Type.TOptional<Type.TNumber>;
}>;
type CronToolOptions = {
    agentSessionKey?: string;
};
type GatewayToolCaller = typeof callGatewayTool;
type CronToolDeps = {
    callGatewayTool?: GatewayToolCaller;
};
export declare function createCronTool(opts?: CronToolOptions, deps?: CronToolDeps): AnyAgentTool;
export {};
