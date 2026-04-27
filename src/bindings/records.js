import { getSessionBindingService, } from "../infra/outbound/session-binding-service.js";
// Shared binding record helpers used by both configured bindings and
// runtime-created plugin conversation bindings.
export async function createConversationBindingRecord(input) {
    return await getSessionBindingService().bind(input);
}
export function getConversationBindingCapabilities(params) {
    return getSessionBindingService().getCapabilities(params);
}
export function listSessionBindingRecords(targetSessionKey) {
    return getSessionBindingService().listBySession(targetSessionKey);
}
export function resolveConversationBindingRecord(conversation) {
    return getSessionBindingService().resolveByConversation(conversation);
}
export function touchConversationBindingRecord(bindingId, at) {
    const service = getSessionBindingService();
    if (typeof at === "number") {
        service.touch(bindingId, at);
        return;
    }
    service.touch(bindingId);
}
export async function unbindConversationBindingRecord(input) {
    return await getSessionBindingService().unbind(input);
}
