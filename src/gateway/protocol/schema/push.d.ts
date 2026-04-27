import { Type } from "typebox";
export declare const PushTestParamsSchema: Type.TObject<{
    nodeId: Type.TString;
    title: Type.TOptional<Type.TString>;
    body: Type.TOptional<Type.TString>;
    environment: Type.TOptional<Type.TString>;
}>;
export declare const PushTestResultSchema: Type.TObject<{
    ok: Type.TBoolean;
    status: Type.TInteger;
    apnsId: Type.TOptional<Type.TString>;
    reason: Type.TOptional<Type.TString>;
    tokenSuffix: Type.TString;
    topic: Type.TString;
    environment: Type.TString;
    transport: Type.TString;
}>;
export declare const WebPushVapidPublicKeyParamsSchema: Type.TObject<{}>;
export declare const WebPushSubscribeParamsSchema: Type.TObject<{
    endpoint: Type.TString;
    keys: Type.TObject<{
        p256dh: Type.TString;
        auth: Type.TString;
    }>;
}>;
export declare const WebPushUnsubscribeParamsSchema: Type.TObject<{
    endpoint: Type.TString;
}>;
export declare const WebPushTestParamsSchema: Type.TObject<{
    title: Type.TOptional<Type.TString>;
    body: Type.TOptional<Type.TString>;
}>;
export type WebPushVapidPublicKeyParams = Record<string, never>;
export type WebPushSubscribeParams = {
    endpoint: string;
    keys: {
        p256dh: string;
        auth: string;
    };
};
export type WebPushUnsubscribeParams = {
    endpoint: string;
};
export type WebPushTestParams = {
    title?: string;
    body?: string;
};
