import { Type } from "typebox";
export declare const DevicePairListParamsSchema: Type.TObject<{}>;
export declare const DevicePairApproveParamsSchema: Type.TObject<{
    requestId: Type.TString;
}>;
export declare const DevicePairRejectParamsSchema: Type.TObject<{
    requestId: Type.TString;
}>;
export declare const DevicePairRemoveParamsSchema: Type.TObject<{
    deviceId: Type.TString;
}>;
export declare const DeviceTokenRotateParamsSchema: Type.TObject<{
    deviceId: Type.TString;
    role: Type.TString;
    scopes: Type.TOptional<Type.TArray<Type.TString>>;
}>;
export declare const DeviceTokenRevokeParamsSchema: Type.TObject<{
    deviceId: Type.TString;
    role: Type.TString;
}>;
export declare const DevicePairRequestedEventSchema: Type.TObject<{
    requestId: Type.TString;
    deviceId: Type.TString;
    publicKey: Type.TString;
    displayName: Type.TOptional<Type.TString>;
    platform: Type.TOptional<Type.TString>;
    deviceFamily: Type.TOptional<Type.TString>;
    clientId: Type.TOptional<Type.TString>;
    clientMode: Type.TOptional<Type.TString>;
    role: Type.TOptional<Type.TString>;
    roles: Type.TOptional<Type.TArray<Type.TString>>;
    scopes: Type.TOptional<Type.TArray<Type.TString>>;
    remoteIp: Type.TOptional<Type.TString>;
    silent: Type.TOptional<Type.TBoolean>;
    isRepair: Type.TOptional<Type.TBoolean>;
    ts: Type.TInteger;
}>;
export declare const DevicePairResolvedEventSchema: Type.TObject<{
    requestId: Type.TString;
    deviceId: Type.TString;
    decision: Type.TString;
    ts: Type.TInteger;
}>;
