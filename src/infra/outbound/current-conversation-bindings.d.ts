import type { ConversationRef, SessionBindingBindInput, SessionBindingCapabilities, SessionBindingRecord, SessionBindingUnbindInput } from "./session-binding.types.js";
declare function resolveBindingsFilePath(env?: NodeJS.ProcessEnv): string;
export declare function getGenericCurrentConversationBindingCapabilities(params: {
    channel: string;
    accountId: string;
}): SessionBindingCapabilities | null;
export declare function bindGenericCurrentConversation(input: SessionBindingBindInput): Promise<SessionBindingRecord | null>;
export declare function resolveGenericCurrentConversationBinding(ref: ConversationRef): SessionBindingRecord | null;
export declare function listGenericCurrentConversationBindingsBySession(targetSessionKey: string): SessionBindingRecord[];
export declare function touchGenericCurrentConversationBinding(bindingId: string, at?: number): void;
export declare function unbindGenericCurrentConversationBindings(input: SessionBindingUnbindInput): Promise<SessionBindingRecord[]>;
export declare const __testing: {
    resetCurrentConversationBindingsForTests(params?: {
        deletePersistedFile?: boolean;
        env?: NodeJS.ProcessEnv;
    }): void;
    resolveBindingsFilePath: typeof resolveBindingsFilePath;
};
export {};
