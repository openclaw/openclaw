import { Type } from "typebox";
export declare const NonEmptyString: Type.TString;
export declare const CHAT_SEND_SESSION_KEY_MAX_LENGTH = 512;
export declare const ChatSendSessionKeyString: Type.TString;
export declare const SessionLabelString: Type.TString;
export declare const InputProvenanceSchema: Type.TObject<{
    kind: Type.TString;
    originSessionId: Type.TOptional<Type.TString>;
    sourceSessionKey: Type.TOptional<Type.TString>;
    sourceChannel: Type.TOptional<Type.TString>;
    sourceTool: Type.TOptional<Type.TString>;
}>;
export declare const GatewayClientIdSchema: Type.TEnum<["webchat-ui", "openclaw-control-ui", "openclaw-tui", "webchat", "cli", "gateway-client", "openclaw-macos", "openclaw-ios", "openclaw-android", "node-host", "test", "fingerprint", "openclaw-probe"]>;
export declare const GatewayClientModeSchema: Type.TEnum<["webchat", "cli", "test", "probe", "ui", "backend", "node"]>;
export declare const SecretRefSourceSchema: Type.TUnion<[Type.TLiteral<"env">, Type.TLiteral<"file">, Type.TLiteral<"exec">]>;
export declare const SecretRefSchema: Type.TUnion<[Type.TObject<{
    source: Type.TLiteral<"env">;
    provider: Type.TString;
    id: Type.TString;
}>, Type.TObject<{
    source: Type.TLiteral<"file">;
    provider: Type.TString;
    id: Type.TString;
}>, Type.TObject<{
    source: Type.TLiteral<"exec">;
    provider: Type.TString;
    id: Type.TString;
}>]>;
export declare const SecretInputSchema: Type.TUnion<[Type.TString, Type.TUnion<[Type.TObject<{
    source: Type.TLiteral<"env">;
    provider: Type.TString;
    id: Type.TString;
}>, Type.TObject<{
    source: Type.TLiteral<"file">;
    provider: Type.TString;
    id: Type.TString;
}>, Type.TObject<{
    source: Type.TLiteral<"exec">;
    provider: Type.TString;
    id: Type.TString;
}>]>]>;
