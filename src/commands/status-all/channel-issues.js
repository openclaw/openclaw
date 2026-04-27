export function groupChannelIssuesByChannel(issues) {
    const byChannel = new Map();
    for (const issue of issues) {
        const key = issue.channel;
        const list = byChannel.get(key);
        if (list) {
            list.push(issue);
        }
        else {
            byChannel.set(key, [issue]);
        }
    }
    return byChannel;
}
