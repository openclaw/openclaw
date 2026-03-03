import { withRemoteHttpResponse } from "./remote-http.js";
export async function postJson(params) {
    return await withRemoteHttpResponse({
        url: params.url,
        ssrfPolicy: params.ssrfPolicy,
        init: {
            method: "POST",
            headers: params.headers,
            body: JSON.stringify(params.body),
        },
        onResponse: async (res) => {
            if (!res.ok) {
                const text = await res.text();
                const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`);
                if (params.attachStatus) {
                    err.status = res.status;
                }
                throw err;
            }
            return await params.parse(await res.json());
        },
    });
}
