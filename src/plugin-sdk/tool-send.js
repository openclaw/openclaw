export function extractToolSend(args, expectedAction = "sendMessage") {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== expectedAction) {
        return null;
    }
    const to = typeof args.to === "string" ? args.to : undefined;
    if (!to) {
        return null;
    }
    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
}
