import { type ConversationRef, type SessionBindingBindInput, type SessionBindingCapabilities, type SessionBindingRecord, type SessionBindingUnbindInput } from "../infra/outbound/session-binding-service.js";
export declare function createConversationBindingRecord(input: SessionBindingBindInput): Promise<SessionBindingRecord>;
export declare function getConversationBindingCapabilities(params: {
    channel: string;
    accountId: string;
}): SessionBindingCapabilities;
export declare function listSessionBindingRecords(targetSessionKey: string): SessionBindingRecord[];
export declare function resolveConversationBindingRecord(conversation: ConversationRef): SessionBindingRecord | null;
export declare function touchConversationBindingRecord(bindingId: string, at?: number): void;
export declare function unbindConversationBindingRecord(input: SessionBindingUnbindInput): Promise<SessionBindingRecord[]>;
