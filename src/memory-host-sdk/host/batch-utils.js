export function normalizeBatchBaseUrl(client) {
    return client.baseUrl?.replace(/\/$/, "") ?? "";
}
export function buildBatchHeaders(client, params) {
    const headers = client.headers ? { ...client.headers } : {};
    if (params.json) {
        if (!headers["Content-Type"] && !headers["content-type"]) {
            headers["Content-Type"] = "application/json";
        }
    }
    else {
        delete headers["Content-Type"];
        delete headers["content-type"];
    }
    return headers;
}
export function splitBatchRequests(requests, maxRequests) {
    if (requests.length <= maxRequests) {
        return [requests];
    }
    const groups = [];
    for (let i = 0; i < requests.length; i += maxRequests) {
        groups.push(requests.slice(i, i + maxRequests));
    }
    return groups;
}
