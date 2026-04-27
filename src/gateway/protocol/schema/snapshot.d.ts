import { Type } from "typebox";
export declare const PresenceEntrySchema: Type.TObject<{
    host: Type.TOptional<Type.TString>;
    ip: Type.TOptional<Type.TString>;
    version: Type.TOptional<Type.TString>;
    platform: Type.TOptional<Type.TString>;
    deviceFamily: Type.TOptional<Type.TString>;
    modelIdentifier: Type.TOptional<Type.TString>;
    mode: Type.TOptional<Type.TString>;
    lastInputSeconds: Type.TOptional<Type.TInteger>;
    reason: Type.TOptional<Type.TString>;
    tags: Type.TOptional<Type.TArray<Type.TString>>;
    text: Type.TOptional<Type.TString>;
    ts: Type.TInteger;
    deviceId: Type.TOptional<Type.TString>;
    roles: Type.TOptional<Type.TArray<Type.TString>>;
    scopes: Type.TOptional<Type.TArray<Type.TString>>;
    instanceId: Type.TOptional<Type.TString>;
}>;
export declare const HealthSnapshotSchema: Type.TAny;
export declare const SessionDefaultsSchema: Type.TObject<{
    defaultAgentId: Type.TString;
    mainKey: Type.TString;
    mainSessionKey: Type.TString;
    scope: Type.TOptional<Type.TString>;
}>;
export declare const StateVersionSchema: Type.TObject<{
    presence: Type.TInteger;
    health: Type.TInteger;
}>;
export declare const SnapshotSchema: Type.TObject<{
    presence: Type.TArray<Type.TObject<{
        host: Type.TOptional<Type.TString>;
        ip: Type.TOptional<Type.TString>;
        version: Type.TOptional<Type.TString>;
        platform: Type.TOptional<Type.TString>;
        deviceFamily: Type.TOptional<Type.TString>;
        modelIdentifier: Type.TOptional<Type.TString>;
        mode: Type.TOptional<Type.TString>;
        lastInputSeconds: Type.TOptional<Type.TInteger>;
        reason: Type.TOptional<Type.TString>;
        tags: Type.TOptional<Type.TArray<Type.TString>>;
        text: Type.TOptional<Type.TString>;
        ts: Type.TInteger;
        deviceId: Type.TOptional<Type.TString>;
        roles: Type.TOptional<Type.TArray<Type.TString>>;
        scopes: Type.TOptional<Type.TArray<Type.TString>>;
        instanceId: Type.TOptional<Type.TString>;
    }>>;
    health: Type.TAny;
    stateVersion: Type.TObject<{
        presence: Type.TInteger;
        health: Type.TInteger;
    }>;
    uptimeMs: Type.TInteger;
    configPath: Type.TOptional<Type.TString>;
    stateDir: Type.TOptional<Type.TString>;
    sessionDefaults: Type.TOptional<Type.TObject<{
        defaultAgentId: Type.TString;
        mainKey: Type.TString;
        mainSessionKey: Type.TString;
        scope: Type.TOptional<Type.TString>;
    }>>;
    authMode: Type.TOptional<Type.TUnion<[Type.TLiteral<"none">, Type.TLiteral<"token">, Type.TLiteral<"password">, Type.TLiteral<"trusted-proxy">]>>;
    updateAvailable: Type.TOptional<Type.TObject<{
        currentVersion: Type.TString;
        latestVersion: Type.TString;
        channel: Type.TString;
    }>>;
}>;
